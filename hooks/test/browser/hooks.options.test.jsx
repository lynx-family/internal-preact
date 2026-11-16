import {
	afterDiffSpy,
	beforeRenderSpy,
	unmountSpy,
	hookSpy
} from '../../../test/_util/optionSpies';

import { setupRerender, act } from 'preact/test-utils';
import {
	createElement,
	render,
	createContext,
	Component,
	options
} from 'preact';
import { setupScratch, teardown } from '../../../test/_util/helpers';
import {
	useState,
	useReducer,
	useEffect,
	useLayoutEffect,
	useRef,
	useImperativeHandle,
	useMemo,
	useCallback,
	useContext,
	useErrorBoundary
} from 'preact/hooks';
import { vi } from 'vitest';

describe('hook options', () => {
	/** @type {HTMLDivElement} */
	let scratch;

	/** @type {() => void} */
	let rerender;

	/** @type {() => void} */
	let increment;

	beforeEach(() => {
		scratch = setupScratch();
		rerender = setupRerender();

		afterDiffSpy.mockClear();
		unmountSpy.mockClear();
		beforeRenderSpy.mockClear();
		hookSpy.mockClear();
	});

	afterEach(() => {
		teardown(scratch);
	});

	function App() {
		const [count, setCount] = useState(0);
		increment = () => setCount(prevCount => prevCount + 1);
		return <div>{count}</div>;
	}

	it('should call old options on mount', () => {
		render(<App />, scratch);

		expect(beforeRenderSpy).toHaveBeenCalled();
		expect(afterDiffSpy).toHaveBeenCalled();
	});

	it('should call old options.diffed on update', () => {
		render(<App />, scratch);

		increment();
		rerender();

		expect(beforeRenderSpy).toHaveBeenCalled();
		expect(afterDiffSpy).toHaveBeenCalled();
	});

	it('should call old options on unmount', () => {
		render(<App />, scratch);
		render(null, scratch);

		expect(unmountSpy).toHaveBeenCalled();
	});

	it('should detect hooks', () => {
		const USE_STATE = 1;
		const USE_REDUCER = 2;
		const USE_EFFECT = 3;
		const USE_LAYOUT_EFFECT = 4;
		const USE_REF = 5;
		const USE_IMPERATIVE_HANDLE = 6;
		const USE_MEMO = 7;
		const USE_CALLBACK = 8;
		const USE_CONTEXT = 9;
		const USE_ERROR_BOUNDARY = 10;

		const Ctx = createContext(null);

		function App() {
			useState(0);
			useReducer(x => x, 0);
			useEffect(() => null, []);
			useLayoutEffect(() => null, []);
			const ref = useRef(null);
			useImperativeHandle(ref, () => null);
			useMemo(() => null, []);
			useCallback(() => null, []);
			useContext(Ctx);
			useErrorBoundary(() => null);
		}

		render(
			<Ctx.Provider value="a">
				<App />
			</Ctx.Provider>,
			scratch
		);

		expect(hookSpy.mock.calls.map(arg => [arg[1], arg[2]])).to.deep.equal([
			[0, USE_STATE],
			[1, USE_REDUCER],
			[2, USE_EFFECT],
			[3, USE_LAYOUT_EFFECT],
			[4, USE_REF],
			[5, USE_IMPERATIVE_HANDLE],
			[6, USE_MEMO],
			[7, USE_CALLBACK],
			[8, USE_CONTEXT],
			[9, USE_ERROR_BOUNDARY],
			// Belongs to useErrorBoundary that uses multiple native hooks.
			[10, USE_STATE]
		]);
	});

	describe('Effects', () => {
		beforeEach(() => {
			options._skipEffects = options.__s = true;
		});

		afterEach(() => {
			options._skipEffects = options.__s = false;
		});

		it('should skip effect hooks', () => {
			const spy = vi.fn();
			function App() {
				useEffect(spy, []);
				useLayoutEffect(spy, []);
				return null;
			}

			act(() => {
				render(<App />, scratch);
			});

			expect(spy).not.toHaveBeenCalled();
		});
	});

	it('emits batch and component-level _passiveEffect scopes with consistent owner vnode and no disabled overhead', () => {
		const prevPassiveEffect = options._passiveEffect;
		const events = [];
		let mountedVNode = null;
		const prevDiffed = options.diffed;

		options.diffed = vnode => {
			if (prevDiffed) prevDiffed(vnode);
			if (vnode.type === MultiEffectChild) {
				mountedVNode = vnode;
			}
		};

		function MultiEffectChild() {
			useEffect(() => () => {}, []);
			useEffect(() => () => {}, []);
			return <div>child</div>;
		}

		try {
			// Drain any passive effects left queued by earlier non-act() tests in this file.
			function Drain() {
				useEffect(() => {}, []);
				return null;
			}
			act(() => {
				render(<Drain />, scratch);
			});
			act(() => {
				render(null, scratch);
			});

			options._passiveEffect = (phase, vnode, comp) => {
				events.push({
					phase,
					vnode,
					hasComp: comp != null
				});
				if (prevPassiveEffect) prevPassiveEffect(phase, vnode, comp);
			};

			act(() => {
				render(<MultiEffectChild />, scratch);
			});
			expect(mountedVNode).to.be.an('object');
			// Two useEffect hooks on one component emit a single component-level (1/2) scope inside batch (0/3).
			expect(events).to.deep.equal([
				{ phase: 0, vnode: undefined, hasComp: false },
				{ phase: 1, vnode: mountedVNode, hasComp: true },
				{ phase: 2, vnode: mountedVNode, hasComp: true },
				{ phase: 3, vnode: undefined, hasComp: false }
			]);

			events.length = 0;
			act(() => {
				render(null, scratch);
			});
			// Unmounting that component also groups both deferred cleanups into a single (1/2) scope with the same owner vnode.
			expect(events).to.deep.equal([
				{ phase: 0, vnode: undefined, hasComp: false },
				{ phase: 1, vnode: mountedVNode, hasComp: true },
				{ phase: 2, vnode: mountedVNode, hasComp: true },
				{ phase: 3, vnode: undefined, hasComp: false }
			]);

			// If deferred cleanup #1 throws, cleanup #2 still runs inside the same (1/2) scope.
			let cleanup2Ran = false;
			let throwingVNode = null;
			options.diffed = vnode => {
				if (prevDiffed) prevDiffed(vnode);
				if (vnode.type === ThrowingCleanupChild) {
					throwingVNode = vnode;
				}
			};
			function ThrowingCleanupChild() {
				useEffect(
					() => () => {
						throw new Error('cleanup boom');
					},
					[]
				);
				useEffect(
					() => () => {
						cleanup2Ran = true;
					},
					[]
				);
				return <div>throw-cleanup</div>;
			}
			class CatchBoundary extends Component {
				componentDidCatch() {
					this.setState({ caught: true });
				}
				render() {
					return this.props.show ? <ThrowingCleanupChild /> : null;
				}
			}
			act(() => {
				render(<CatchBoundary show />, scratch);
			});
			events.length = 0;
			act(() => {
				render(<CatchBoundary show={false} />, scratch);
			});
			expect(cleanup2Ran).to.equal(true);
			expect(events).to.deep.equal([
				{ phase: 0, vnode: undefined, hasComp: false },
				{ phase: 1, vnode: throwingVNode, hasComp: true },
				{ phase: 2, vnode: throwingVNode, hasComp: true },
				{ phase: 3, vnode: undefined, hasComp: false }
			]);
			act(() => {
				render(null, scratch);
			});

			// When _passiveEffect is disabled, unmount does not attach _unmountVNode onto hook state.
			options._passiveEffect = undefined;
			let effectHookState;
			options.diffed = vnode => {
				if (prevDiffed) prevDiffed(vnode);
				const comp = vnode._component;
				if (comp && comp.__hooks && comp.__hooks._list[0]) {
					effectHookState = comp.__hooks._list[0];
				}
			};
			act(() => {
				render(<MultiEffectChild />, scratch);
			});
			const keysBeforeUnmount = Object.keys(effectHookState).sort();
			render(null, scratch);
			expect('_unmountVNode' in effectHookState).to.equal(false);
			expect(Object.keys(effectHookState).sort()).to.deep.equal(
				keysBeforeUnmount
			);
			act(() => {});
		} finally {
			options.diffed = prevDiffed;
			options._passiveEffect = prevPassiveEffect;
		}
	});
});
