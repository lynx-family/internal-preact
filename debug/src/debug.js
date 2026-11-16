import { checkPropTypes } from './check-props';
import { options, Component } from 'preact';
import {
	ELEMENT_NODE,
	DOCUMENT_NODE,
	DOCUMENT_FRAGMENT_NODE
} from './constants';
import {
	getOwnerStack,
	setupComponentStack,
	getCurrentVNode,
	getDisplayName
} from './component-stack';
import { isNaN } from './util';

const isWeakMapSupported = typeof WeakMap == 'function';

/**
 * @param {import('./internal').VNode} vnode
 * @returns {Array<string>}
 */
function getDomChildren(vnode) {
	let domChildren = [];

	if (!vnode._children) return domChildren;

	vnode._children.forEach(child => {
		if (child && typeof child.type === 'function') {
			domChildren.push.apply(domChildren, getDomChildren(child));
		} else if (child && typeof child.type === 'string') {
			domChildren.push(child.type);
		}
	});

	return domChildren;
}

/**
 * @param {import('./internal').VNode} parent
 * @returns {string}
 */
function getClosestDomNodeParentName(parent) {
	if (!parent) return '';
	if (typeof parent.type == 'function') {
		if (parent._parent == null) {
			if (parent._dom != null && parent._dom.parentNode != null) {
				return parent._dom.parentNode.localName;
			}
			return '';
		}
		return getClosestDomNodeParentName(parent._parent);
	}
	return /** @type {string} */ (parent.type);
}

const PASSIVE_UPDATE_LIMIT = 50;

/**
 * Resolve the render container for a mounted component, or null if unmounted.
 * @param {import('./internal').Component | null | undefined} component
 * @returns {import('./internal').PreactElement | null}
 */
function getRenderRoot(component) {
	if (!component || !component._parentDom) {
		return null;
	}
	let rootVNode = component._vnode;
	if (!rootVNode) {
		return null;
	}
	while (rootVNode._parent) {
		rootVNode = rootVNode._parent;
	}
	const rootComponent = rootVNode._component;
	const rootDom = rootComponent && rootComponent._parentDom;
	if (!rootDom) {
		return null;
	}
	return rootDom.nodeType === DOCUMENT_NODE ? rootDom.documentElement : rootDom;
}

export function initDebug() {
	setupComponentStack();

	let hooksAllowed = false;

	/* eslint-disable no-console */
	let oldBeforeDiff = options._diff;
	let oldDiffed = options.diffed;
	let oldVnode = options.vnode;
	let oldRender = options._render;
	let oldCatchError = options._catchError;
	let oldRoot = options._root;
	let oldHook = options._hook;
	let oldUnmount = options.unmount;
	let oldCommit = options._commit;
	let oldEnqueueRender = options._enqueueRender;
	let oldRenderPass = options._renderPass;
	let oldPassiveEffect = options._passiveEffect;
	const warnedComponents = !isWeakMapSupported
		? null
		: {
				useEffect: new WeakMap(),
				useLayoutEffect: new WeakMap(),
				lazyPropTypes: new WeakMap()
			};
	const deprecations = [];
	const passiveUpdateStreaks = isWeakMapSupported ? new WeakMap() : null;
	const passiveBatchStack = [];
	const passiveEffectStack = [];
	const renderPassStack = [];
	const queuedComponents = [];
	const queuedRoots = [];
	const pendingUnmountVNodes = [];
	const pendingUnmountRoots = [];
	let stepSeq = 0;

	function cleanBatchRoot(batch, root) {
		if (!batch) return;
		const touchedIdx = batch.touchedRoots.indexOf(root);
		if (touchedIdx !== -1) {
			batch.touchedRoots.splice(touchedIdx, 1);
		}
		const updatedIdx = batch.updatedRoots.indexOf(root);
		if (updatedIdx !== -1) {
			batch.updatedRoots.splice(updatedIdx, 1);
			batch.triggerVNodes.splice(updatedIdx, 1);
		}
	}

	function removeQueuedComponent(comp) {
		if (!comp) return;
		const idx = queuedComponents.indexOf(comp);
		if (idx !== -1) {
			queuedComponents.splice(idx, 1);
		}
	}

	/**
	 * @param {import('./internal').PreactElement} root
	 */
	function resetPassiveUpdateStreak(root) {
		if (!passiveUpdateStreaks) return;
		passiveUpdateStreaks.delete(root);
		const queuedRootIdx = queuedRoots.indexOf(root);
		if (queuedRootIdx !== -1) {
			queuedRoots.splice(queuedRootIdx, 1);
		}
		for (let i = pendingUnmountRoots.length - 1; i >= 0; i--) {
			if (pendingUnmountRoots[i] === root) {
				pendingUnmountVNodes.splice(i, 1);
				pendingUnmountRoots.splice(i, 1);
			}
		}
		for (let i = 0; i < passiveBatchStack.length; i++) {
			cleanBatchRoot(passiveBatchStack[i], root);
		}
		for (let i = 0; i < passiveEffectStack.length; i++) {
			cleanBatchRoot(passiveEffectStack[i].standaloneBatch, root);
			if (passiveEffectStack[i].root === root) {
				passiveEffectStack[i].root = null;
			}
		}
		for (let i = 0; i < renderPassStack.length; i++) {
			cleanBatchRoot(renderPassStack[i].preRenderBatch, root);
			const committedIdx = renderPassStack[i].committedRoots.indexOf(root);
			if (committedIdx !== -1) {
				renderPassStack[i].committedRoots.splice(committedIdx, 1);
			}
		}
	}

	function finalizePassiveBatch(batch) {
		if (!batch) return;
		for (let i = 0; i < batch.touchedRoots.length; i++) {
			const root = batch.touchedRoots[i];
			const updatedIdx = batch.updatedRoots.indexOf(root);
			if (updatedIdx !== -1) {
				const nextCount = (passiveUpdateStreaks.get(root) || 0) + 1;
				if (nextCount > PASSIVE_UPDATE_LIMIT) {
					passiveUpdateStreaks.delete(root);
					const triggerVNode = batch.triggerVNodes[updatedIdx];
					const stack = triggerVNode ? getOwnerStack(triggerVNode) : '';
					console.error(
						'Maximum update depth exceeded. This can happen when a component ' +
							"calls setState inside useEffect, but useEffect either doesn't " +
							'have a dependency array, or one of the dependencies changes on ' +
							'every render.' +
							(stack ? `\n\n${stack}` : '')
					);
				} else {
					passiveUpdateStreaks.set(root, nextCount);
				}
			} else {
				passiveUpdateStreaks.delete(root);
			}
		}
	}

	function hasPendingPassiveOrRenderWork(root) {
		for (let i = 0; i < passiveEffectStack.length; i++) {
			if (passiveEffectStack[i].root === root) return true;
		}
		for (let i = 0; i < passiveBatchStack.length; i++) {
			const batch = passiveBatchStack[i];
			if (
				batch.touchedRoots.indexOf(root) !== -1 ||
				batch.updatedRoots.indexOf(root) !== -1
			) {
				return true;
			}
		}
		if (pendingUnmountRoots.indexOf(root) !== -1) {
			return true;
		}
		let write = 0;
		let hasQueuedForRoot = false;
		for (let i = 0; i < queuedComponents.length; i++) {
			const comp = queuedComponents[i];
			if (comp && comp._parentDom) {
				queuedComponents[write++] = comp;
				if (!hasQueuedForRoot && getRenderRoot(comp) === root) {
					hasQueuedForRoot = true;
				}
			}
		}
		queuedComponents.length = write;
		if (hasQueuedForRoot) return true;

		if (root && root._children) {
			const stack = [root._children];
			while (stack.length) {
				const vnode = stack.pop();
				if (!vnode) continue;
				const comp = vnode._component;
				if (
					comp &&
					comp._parentDom &&
					comp.__hooks &&
					comp.__hooks._pendingEffects &&
					comp.__hooks._pendingEffects.length
				) {
					return true;
				}
				const children = vnode._children;
				if (children) {
					for (let i = 0; i < children.length; i++) {
						if (children[i]) stack.push(children[i]);
					}
				}
			}
		}
		return false;
	}

	options._catchError = (error, vnode, oldVNode, errorInfo) => {
		let component = vnode && vnode._component;
		if (component && typeof error.then == 'function') {
			const promise = error;
			error = new Error(
				`Missing Suspense. The throwing component was: ${getDisplayName(vnode)}`
			);

			let parent = vnode;
			for (; parent; parent = parent._parent) {
				if (parent._component && parent._component._childDidSuspend) {
					error = promise;
					break;
				}
			}

			// We haven't recovered and we know at this point that there is no
			// Suspense component higher up in the tree
			if (error instanceof Error) {
				throw error;
			}
		}

		errorInfo = errorInfo || {};
		errorInfo.componentStack = getOwnerStack(vnode);
		oldCatchError(error, vnode, oldVNode, errorInfo);

		// when an error was handled by an ErrorBoundary we still log it, matching what
		// React does in development. Errors that were not handled are rethrown by the
		// core and thus surface as regular uncaught errors.
		if (typeof error.then != 'function') {
			console.error(error);
		}
	};

	options._root = (vnode, parentNode) => {
		if (!parentNode) {
			throw new Error(
				'Undefined parent passed to render(), this is the second argument.\n' +
					'Check if the element is available in the DOM/has the correct id.'
			);
		}

		let isValid;
		switch (parentNode.nodeType) {
			case ELEMENT_NODE:
			case DOCUMENT_FRAGMENT_NODE:
			case DOCUMENT_NODE:
				isValid = true;
				break;
			default:
				isValid = false;
		}

		if (!isValid) {
			let componentName = getDisplayName(vnode);
			throw new Error(
				`Expected a valid HTML node as a second argument to render.	Received ${parentNode} instead: render(<${componentName} />, ${parentNode});`
			);
		}

		if (vnode == null || typeof vnode == 'boolean') {
			const root =
				parentNode.nodeType === DOCUMENT_NODE
					? parentNode.documentElement
					: parentNode;
			if (root) resetPassiveUpdateStreak(root);
		}

		if (oldRoot) oldRoot(vnode, parentNode);
	};

	options._diff = vnode => {
		let { type } = vnode;

		hooksAllowed = true;

		if (type === undefined) {
			throw new Error(
				'Undefined component passed to createElement()\n\n' +
					'You likely forgot to export your component or might have mixed up default and named imports' +
					serializeVNode(vnode) +
					`\n\n${getOwnerStack(vnode)}`
			);
		} else if (type != null && typeof type == 'object') {
			if (type._children !== undefined && type._dom !== undefined) {
				throw new Error(
					`Invalid type passed to createElement(): ${type}\n\n` +
						'Did you accidentally pass a JSX literal as JSX twice?\n\n' +
						`  let My${getDisplayName(vnode)} = ${serializeVNode(type)};\n` +
						`  let vnode = <My${getDisplayName(vnode)} />;\n\n` +
						'This usually happens when you export a JSX literal and not the component.' +
						`\n\n${getOwnerStack(vnode)}`
				);
			}

			throw new Error(
				'Invalid type passed to createElement(): ' +
					(Array.isArray(type) ? 'array' : type)
			);
		}

		if (
			vnode.ref !== undefined &&
			typeof vnode.ref != 'function' &&
			typeof vnode.ref != 'object' &&
			!('$$typeof' in vnode) // allow string refs when preact-compat is installed
		) {
			throw new Error(
				`Component's "ref" property should be a function, or an object created ` +
					`by createRef(), but got [${typeof vnode.ref}] instead\n` +
					serializeVNode(vnode) +
					`\n\n${getOwnerStack(vnode)}`
			);
		}

		if (typeof vnode.type == 'string') {
			for (const key in vnode.props) {
				if (
					key[0] === 'o' &&
					key[1] === 'n' &&
					typeof vnode.props[key] != 'function' &&
					vnode.props[key] != null
				) {
					throw new Error(
						`Component's "${key}" property should be a function, ` +
							`but got [${typeof vnode.props[key]}] instead\n` +
							serializeVNode(vnode) +
							`\n\n${getOwnerStack(vnode)}`
					);
				}
			}
		}

		// Check prop-types if available
		if (typeof vnode.type == 'function' && vnode.type.propTypes) {
			if (
				vnode.type.displayName === 'Lazy' &&
				warnedComponents &&
				!warnedComponents.lazyPropTypes.has(vnode.type)
			) {
				const m =
					'PropTypes are not supported on lazy(). Use propTypes on the wrapped component itself. ';
				try {
					const lazyVNode = vnode.type();
					warnedComponents.lazyPropTypes.set(vnode.type, true);
					console.warn(
						m + `Component wrapped in lazy() is ${getDisplayName(lazyVNode)}`
					);
				} catch (promise) {
					console.warn(
						m + "We will log the wrapped component's name once it is loaded."
					);
				}
			}

			/* eslint-disable-next-line */
			const { ref: _ref, ...props } = vnode.props;

			checkPropTypes(
				vnode.type.propTypes,
				props,
				'prop',
				getDisplayName(vnode),
				() => getOwnerStack(vnode)
			);
		}

		if (oldBeforeDiff) oldBeforeDiff(vnode);
	};

	let renderCount = 0;
	let currentComponent;
	options._render = vnode => {
		removeQueuedComponent(vnode && vnode._component);
		if (oldRender) {
			oldRender(vnode);
		}
		hooksAllowed = true;

		const nextComponent = vnode._component;
		if (nextComponent === currentComponent) {
			renderCount++;
		} else {
			renderCount = 1;
		}

		if (renderCount >= 25) {
			throw new Error(
				`Too many re-renders. This is limited to prevent an infinite loop ` +
					`which may lock up your browser. The component causing this is: ${getDisplayName(
						vnode
					)}`
			);
		}

		currentComponent = nextComponent;
	};

	options._hook = (comp, index, type) => {
		if (!comp || !hooksAllowed) {
			throw new Error('Hook can only be invoked from render methods.');
		}

		if (oldHook) oldHook(comp, index, type);
	};

	options.unmount = vnode => {
		if (passiveUpdateStreaks && vnode) {
			const comp = vnode._component;
			removeQueuedComponent(comp);
			const hooks = comp && comp.__hooks;
			const list = hooks && hooks._list;
			if (list) {
				for (let i = 0; i < list.length; i++) {
					const s = list[i];
					if (s && s._passive && typeof s._cleanup == 'function') {
						const root = getRenderRoot(comp);
						if (root) {
							pendingUnmountVNodes.push(vnode);
							pendingUnmountRoots.push(root);
						}
						break;
					}
				}
			}
		}
		if (oldUnmount) oldUnmount(vnode);
	};

	options._commit = (vnode, commitQueue) => {
		if (oldCommit) oldCommit(vnode, commitQueue);
		if (passiveUpdateStreaks && renderPassStack.length) {
			const root = getRenderRoot(vnode && vnode._component);
			const pass = renderPassStack[renderPassStack.length - 1];
			if (root && pass.committedRoots.indexOf(root) === -1) {
				pass.committedRoots.push(root);
			}
		}
	};

	options._renderPass = (phase, isQueueFlush) => {
		if (oldRenderPass) oldRenderPass(phase, isQueueFlush);
		if (!passiveUpdateStreaks) return;

		if (phase === 0) {
			renderPassStack.push({
				seq: ++stepSeq,
				preRenderBatch: null,
				committedRoots: []
			});
		} else if (phase === 1) {
			const pass = renderPassStack.pop();
			if (isQueueFlush) {
				if (pass) {
					for (let i = 0; i < queuedRoots.length; i++) {
						const root = queuedRoots[i];
						if (pass.committedRoots.indexOf(root) === -1) {
							pass.committedRoots.push(root);
						}
					}
				}
				queuedComponents.length = queuedRoots.length = 0;
			}
			if (!pass) return;

			if (pass.preRenderBatch) {
				for (let i = 0; i < pass.preRenderBatch.touchedRoots.length; i++) {
					const root = pass.preRenderBatch.touchedRoots[i];
					if (pass.committedRoots.indexOf(root) === -1) {
						pass.committedRoots.push(root);
					}
				}
				finalizePassiveBatch(pass.preRenderBatch);
			}

			if (renderPassStack.length) {
				const parentPass = renderPassStack[renderPassStack.length - 1];
				for (let i = 0; i < pass.committedRoots.length; i++) {
					const root = pass.committedRoots[i];
					if (parentPass.committedRoots.indexOf(root) === -1) {
						parentPass.committedRoots.push(root);
					}
				}
			} else {
				for (let i = 0; i < pass.committedRoots.length; i++) {
					const root = pass.committedRoots[i];
					if (
						passiveUpdateStreaks.has(root) &&
						!hasPendingPassiveOrRenderWork(root)
					) {
						passiveUpdateStreaks.delete(root);
					}
				}
			}
		}
	};

	options._passiveEffect = (phase, vnode, component) => {
		if (oldPassiveEffect) oldPassiveEffect(phase, vnode, component);
		if (!passiveUpdateStreaks) return;

		if (phase === 0) {
			passiveBatchStack.push({
				seq: ++stepSeq,
				touchedRoots: [],
				updatedRoots: [],
				triggerVNodes: []
			});
		} else if (phase === 1) {
			const topBatch = passiveBatchStack[passiveBatchStack.length - 1];
			const topPass = renderPassStack[renderPassStack.length - 1];
			let batch;
			let standaloneBatch = null;
			if (topBatch && (!topPass || topBatch.seq > topPass.seq)) {
				batch = topBatch;
			} else if (topPass) {
				if (!topPass.preRenderBatch) {
					topPass.preRenderBatch = {
						seq: topPass.seq,
						touchedRoots: [],
						updatedRoots: [],
						triggerVNodes: []
					};
				}
				batch = topPass.preRenderBatch;
			} else {
				standaloneBatch = batch = {
					seq: ++stepSeq,
					touchedRoots: [],
					updatedRoots: [],
					triggerVNodes: []
				};
			}

			let root = getRenderRoot(component);
			if (!root && vnode) {
				const unmountIdx = pendingUnmountVNodes.indexOf(vnode);
				if (unmountIdx !== -1) {
					root = pendingUnmountRoots[unmountIdx];
				}
			}
			passiveEffectStack.push({
				root,
				vnode: vnode || (component && component._vnode) || null,
				batch,
				standaloneBatch
			});
			if (root && batch.touchedRoots.indexOf(root) === -1) {
				batch.touchedRoots.push(root);
			}
		} else if (phase === 2) {
			if (vnode) {
				const idx = pendingUnmountVNodes.indexOf(vnode);
				if (idx !== -1) {
					pendingUnmountVNodes.splice(idx, 1);
					pendingUnmountRoots.splice(idx, 1);
				}
			}
			const frame = passiveEffectStack.pop();
			if (frame && frame.standaloneBatch) {
				finalizePassiveBatch(frame.standaloneBatch);
			}
		} else if (phase === 3) {
			pendingUnmountVNodes.length = pendingUnmountRoots.length = 0;
			finalizePassiveBatch(passiveBatchStack.pop());
		}
	};

	options._enqueueRender = component => {
		if (oldEnqueueRender) oldEnqueueRender(component);
		if (!passiveUpdateStreaks || !component) return;

		if (queuedComponents.indexOf(component) === -1) {
			queuedComponents.push(component);
		}
		const targetRoot = getRenderRoot(component);
		if (targetRoot && queuedRoots.indexOf(targetRoot) === -1) {
			queuedRoots.push(targetRoot);
		}
		if (!passiveEffectStack.length) return;

		const active = passiveEffectStack[passiveEffectStack.length - 1];
		if (active.root && targetRoot === active.root && active.batch) {
			if (active.batch.updatedRoots.indexOf(targetRoot) === -1) {
				active.batch.updatedRoots.push(targetRoot);
				active.batch.triggerVNodes.push(
					active.vnode || (component && component._vnode) || null
				);
			}
		}
	};

	// Ideally we'd want to print a warning once per component, but we
	// don't have access to the vnode that triggered it here. As a
	// compromise and to avoid flooding the console with warnings we
	// print each deprecation warning only once.
	const warn = (property, message) => ({
		get() {
			const key = 'get' + property + message;
			if (deprecations && deprecations.indexOf(key) < 0) {
				deprecations.push(key);
				console.warn(`getting vnode.${property} is deprecated, ${message}`);
			}
		},
		set() {
			const key = 'set' + property + message;
			if (deprecations && deprecations.indexOf(key) < 0) {
				deprecations.push(key);
				console.warn(`setting vnode.${property} is not allowed, ${message}`);
			}
		}
	});

	const deprecatedAttributes = {
		nodeName: warn('nodeName', 'use vnode.type'),
		attributes: warn('attributes', 'use vnode.props'),
		children: warn('children', 'use vnode.props.children')
	};

	const deprecatedProto = Object.create({}, deprecatedAttributes);

	options.vnode = vnode => {
		const props = vnode.props;
		if (
			vnode.type !== null &&
			props != null &&
			('__source' in props || '__self' in props)
		) {
			const newProps = (vnode.props = {});
			for (let i in props) {
				const v = props[i];
				if (i === '__source') vnode.__source = v;
				else if (i === '__self') vnode.__self = v;
				else newProps[i] = v;
			}
		}

		// eslint-disable-next-line
		vnode.__proto__ = deprecatedProto;
		if (oldVnode) oldVnode(vnode);
	};

	options.diffed = vnode => {
		const { type, _parent: parent } = vnode;
		// Check if the user passed plain objects as children. Note that we cannot
		// move this check into `options.vnode` because components can receive
		// children in any shape they want (e.g.
		// `<MyJSONFormatter>{{ foo: 123, bar: "abc" }}</MyJSONFormatter>`).
		// Putting this check in `options.diffed` ensures that
		// `vnode._children` is set and that we only validate the children
		// that were actually rendered.
		if (vnode._children) {
			vnode._children.forEach(child => {
				if (typeof child === 'object' && child && child.type === undefined) {
					const keys = Object.keys(child).join(',');
					throw new Error(
						`Objects are not valid as a child. Encountered an object with the keys {${keys}}.` +
							`\n\n${getOwnerStack(vnode)}`
					);
				}
			});
		}

		if (vnode._component === currentComponent) {
			renderCount = 0;
		}

		if (
			typeof type === 'string' &&
			(isTableElement(type) ||
				type === 'p' ||
				type === 'a' ||
				type === 'button')
		) {
			// Avoid false positives when Preact only partially rendered the
			// HTML tree. Whilst we attempt to include the outer DOM in our
			// validation, this wouldn't work on the server for
			// `preact-render-to-string`. There we'd otherwise flood the terminal
			// with false positives, which we'd like to avoid.
			let domParentName = getClosestDomNodeParentName(parent);
			if (domParentName !== '' && isTableElement(type)) {
				if (
					type === 'table' &&
					// Tables can be nested inside each other if it's inside a cell.
					// See https://developer.mozilla.org/en-US/docs/Learn/HTML/Tables/Advanced#nesting_tables
					domParentName !== 'td' &&
					isTableElement(domParentName)
				) {
					console.error(
						'Improper nesting of table. Your <table> should not have a table-node parent.' +
							serializeVNode(vnode) +
							`\n\n${getOwnerStack(vnode)}`
					);
				} else if (
					(type === 'thead' || type === 'tfoot' || type === 'tbody') &&
					domParentName !== 'table'
				) {
					console.error(
						'Improper nesting of table. Your <thead/tbody/tfoot> should have a <table> parent.' +
							serializeVNode(vnode) +
							`\n\n${getOwnerStack(vnode)}`
					);
				} else if (
					type === 'tr' &&
					domParentName !== 'thead' &&
					domParentName !== 'tfoot' &&
					domParentName !== 'tbody'
				) {
					console.error(
						'Improper nesting of table. Your <tr> should have a <thead/tbody/tfoot> parent.' +
							serializeVNode(vnode) +
							`\n\n${getOwnerStack(vnode)}`
					);
				} else if (type === 'td' && domParentName !== 'tr') {
					console.error(
						'Improper nesting of table. Your <td> should have a <tr> parent.' +
							serializeVNode(vnode) +
							`\n\n${getOwnerStack(vnode)}`
					);
				} else if (type === 'th' && domParentName !== 'tr') {
					console.error(
						'Improper nesting of table. Your <th> should have a <tr>.' +
							serializeVNode(vnode) +
							`\n\n${getOwnerStack(vnode)}`
					);
				}
			} else if (type === 'p') {
				let illegalDomChildrenTypes = getDomChildren(vnode).filter(childType =>
					ILLEGAL_PARAGRAPH_CHILD_ELEMENTS.test(childType)
				);
				if (illegalDomChildrenTypes.length) {
					console.error(
						'Improper nesting of paragraph. Your <p> should not have ' +
							illegalDomChildrenTypes.join(', ') +
							' as child-elements.' +
							serializeVNode(vnode) +
							`\n\n${getOwnerStack(vnode)}`
					);
				}
			} else if (type === 'a' || type === 'button') {
				if (getDomChildren(vnode).indexOf(type) !== -1) {
					console.error(
						`Improper nesting of interactive content. Your <${type}>` +
							` should not have other ${type === 'a' ? 'anchor' : 'button'}` +
							' tags as child-elements.' +
							serializeVNode(vnode) +
							`\n\n${getOwnerStack(vnode)}`
					);
				}
			}
		}

		hooksAllowed = false;

		if (oldDiffed) oldDiffed(vnode);

		if (vnode._children != null) {
			const keys = [];
			for (let i = 0; i < vnode._children.length; i++) {
				const child = vnode._children[i];
				if (!child || child.key == null) continue;

				const key = child.key;
				if (keys.indexOf(key) !== -1) {
					console.error(
						'Following component has two or more children with the ' +
							`same key attribute: "${key}". This may cause glitches and misbehavior ` +
							'in rendering process. Component: \n\n' +
							serializeVNode(vnode) +
							`\n\n${getOwnerStack(vnode)}`
					);

					// Break early to not spam the console
					break;
				}

				keys.push(key);
			}
		}

		if (vnode._component != null && vnode._component.__hooks != null) {
			// Validate that none of the hooks in this component contain arguments that are NaN.
			// This is a common mistake that can be hard to debug, so we want to catch it early.
			const hooks = vnode._component.__hooks._list;
			if (hooks) {
				for (let i = 0; i < hooks.length; i += 1) {
					const hook = hooks[i];
					if (hook._args) {
						for (let j = 0; j < hook._args.length; j++) {
							const arg = hook._args[j];
							if (isNaN(arg)) {
								const componentName = getDisplayName(vnode);
								console.warn(
									`Invalid argument passed to hook. Hooks should not be called with NaN in the dependency array. Hook index ${i} in component ${componentName} was called with NaN.`
								);
							}
						}
					}
				}
			}
		}
	};
}

const setState = Component.prototype.setState;
Component.prototype.setState = function (update, callback) {
	if (this._vnode == null) {
		// `this._vnode` will be `null` during componentWillMount. But it
		// is perfectly valid to call `setState` during cWM. So we
		// need an additional check to verify that we are dealing with a
		// call inside constructor.
		if (this.state == null) {
			console.warn(
				`Calling "this.setState" inside the constructor of a component is a ` +
					`no-op and might be a bug in your application. Instead, set ` +
					`"this.state = {}" directly.\n\n${getOwnerStack(getCurrentVNode())}`
			);
		}
	}

	return setState.call(this, update, callback);
};

function isTableElement(type) {
	return (
		type === 'table' ||
		type === 'tfoot' ||
		type === 'tbody' ||
		type === 'thead' ||
		type === 'td' ||
		type === 'tr' ||
		type === 'th'
	);
}

const ILLEGAL_PARAGRAPH_CHILD_ELEMENTS =
	/^(address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h1|h2|h3|h4|h5|h6|header|hgroup|hr|main|menu|nav|ol|p|pre|search|section|table|ul)$/;

const forceUpdate = Component.prototype.forceUpdate;
Component.prototype.forceUpdate = function (callback) {
	if (this._vnode == null) {
		console.warn(
			`Calling "this.forceUpdate" inside the constructor of a component is a ` +
				`no-op and might be a bug in your application.\n\n${getOwnerStack(
					getCurrentVNode()
				)}`
		);
	} else if (this._parentDom == null) {
		console.warn(
			`Can't call "this.forceUpdate" on an unmounted component. This is a no-op, ` +
				`but it indicates a memory leak in your application. To fix, cancel all ` +
				`subscriptions and asynchronous tasks in the componentWillUnmount method.` +
				`\n\n${getOwnerStack(this._vnode)}`
		);
	}
	return forceUpdate.call(this, callback);
};

/**
 * Serialize a vnode tree to a string
 * @param {import('./internal').VNode} vnode
 * @returns {string}
 */
export function serializeVNode(vnode) {
	let { props } = vnode;
	let name = getDisplayName(vnode);

	let attrs = '';
	for (let prop in props) {
		if (props.hasOwnProperty(prop) && prop !== 'children') {
			let value = props[prop];

			// If it is an object but doesn't have toString(), use Object.toString
			if (typeof value == 'function') {
				value = `function ${value.displayName || value.name}() {}`;
			}

			value =
				Object(value) === value && !value.toString
					? Object.prototype.toString.call(value)
					: value + '';

			attrs += ` ${prop}=${JSON.stringify(value)}`;
		}
	}

	let children = props.children;
	return `<${name}${attrs}${
		children && children.length ? '>..</' + name + '>' : ' />'
	}`;
}

options._hydrationMismatch = (newVNode, excessDomChildren) => {
	const { type } = newVNode;
	const availableTypes = excessDomChildren
		.map(child => child && child.localName)
		.filter(Boolean);
	console.error(
		`Expected a DOM node of type "${type}" but found "${availableTypes.join(', ')}" as available DOM-node(s), this is caused by the SSR'd HTML containing different DOM-nodes compared to the hydrated one.\n\n${getOwnerStack(newVNode)}`
	);
};
