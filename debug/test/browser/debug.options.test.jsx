import {
	vnodeSpy,
	rootSpy,
	beforeDiffSpy,
	beforeCommitSpy,
	hookSpy,
	afterDiffSpy,
	unmountSpy,
	catchErrorSpy,
	enqueueRenderSpy,
	renderPassSpy,
	passiveEffectSpy
} from '../../../test/_util/optionSpies';

import { createElement, render, Component, options } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { act, setupRerender } from 'preact/test-utils';
import 'preact/debug';
import { setupScratch, teardown } from '../../../test/_util/helpers';
import { vi } from 'vitest';

describe('debug options', () => {
	/** @type {HTMLDivElement} */
	let scratch;

	/** @type {() => void} */
	let rerender;

	/** @type {(count: number) => void} */
	let setCount;

	beforeEach(() => {
		scratch = setupScratch();
		rerender = setupRerender();

		vnodeSpy.mockClear();
		rootSpy.mockClear();
		beforeDiffSpy.mockClear();
		beforeCommitSpy.mockClear();
		hookSpy.mockClear();
		afterDiffSpy.mockClear();
		unmountSpy.mockClear();
		catchErrorSpy.mockClear();
		enqueueRenderSpy.mockClear();
		renderPassSpy.mockClear();
		passiveEffectSpy.mockClear();
	});

	afterEach(() => {
		teardown(scratch);
	});

	class ClassApp extends Component {
		constructor() {
			super();
			this.state = { count: 0 };
			setCount = count => this.setState({ count });
		}

		render() {
			return <div>{this.state.count}</div>;
		}
	}

	it('should call old options on mount', () => {
		render(<ClassApp />, scratch);

		expect(vnodeSpy).toHaveBeenCalled();
		expect(rootSpy).toHaveBeenCalled();
		expect(beforeDiffSpy).toHaveBeenCalled();
		expect(afterDiffSpy).toHaveBeenCalled();
	});

	it('should call old options on update', () => {
		render(<ClassApp />, scratch);

		setCount(1);
		rerender();

		expect(vnodeSpy).toHaveBeenCalled();
		expect(rootSpy).toHaveBeenCalled();
		expect(beforeDiffSpy).toHaveBeenCalled();
		expect(afterDiffSpy).toHaveBeenCalled();
	});

	it('should call old options on unmount', () => {
		render(<ClassApp />, scratch);
		render(null, scratch);

		expect(vnodeSpy).toHaveBeenCalled();
		expect(rootSpy).toHaveBeenCalled();
		expect(beforeDiffSpy).toHaveBeenCalled();
		expect(afterDiffSpy).toHaveBeenCalled();
	});

	it('should call old hook options for hook components', () => {
		function HookApp() {
			const [count, realSetCount] = useState(0);
			setCount = realSetCount;
			return <div>{count}</div>;
		}

		render(<HookApp />, scratch);

		expect(hookSpy).toHaveBeenCalled();
	});

	it('should call old options on error', () => {
		const e = new Error('test');
		class ErrorApp extends Component {
			constructor() {
				super();
				this.state = { error: true };
			}
			componentDidCatch() {
				this.setState({ error: false });
			}
			render() {
				return <Throw error={this.state.error} />;
			}
		}

		function Throw({ error }) {
			if (error) {
				throw e;
			} else {
				return <div>no error</div>;
			}
		}

		// even though the error was handled by an error boundary we still log it,
		// this matches what React does in development
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		let loggedErrors;
		try {
			render(<ErrorApp />, scratch);
			rerender();
		} finally {
			loggedErrors = errorSpy.mock.calls.map(args => args[0]);
			errorSpy.mockRestore();
		}

		expect(catchErrorSpy).toHaveBeenCalled();
		expect(loggedErrors).to.deep.equal([e]);
	});

	it('should call old unmount, _commit, _enqueueRender, _renderPass, and _passiveEffect hooks', () => {
		let trigger;
		function HookApp() {
			const [count, setCount] = useState(0);
			trigger = () => setCount(c => c + 1);
			useEffect(() => () => {}, [count]);
			return <div>{count}</div>;
		}

		act(() => {
			render(<HookApp />, scratch);
		});
		expect(beforeCommitSpy).toHaveBeenCalled();
		expect(renderPassSpy).toHaveBeenCalledWith(0, false);
		expect(renderPassSpy).toHaveBeenCalledWith(1, false);
		expect(passiveEffectSpy).toHaveBeenCalled();

		act(() => {
			trigger();
		});
		expect(enqueueRenderSpy).toHaveBeenCalled();
		expect(renderPassSpy).toHaveBeenCalledWith(0, true);
		expect(renderPassSpy).toHaveBeenCalledWith(1, true);

		act(() => {
			render(null, scratch);
		});
		expect(unmountSpy).toHaveBeenCalled();
	});

	it('delivers paired _renderPass and _passiveEffect events when listeners are replaced mid-pass', () => {
		const prevRenderPass = options._renderPass;
		const prevPassiveEffect = options._passiveEffect;
		const renderPassEventsA = [];
		const renderPassEventsB = [];
		const passiveEventsA = [];
		const passiveEventsB = [];

		options._renderPass = (phase, isFlush) => {
			renderPassEventsA.push([phase, isFlush]);
			prevRenderPass(phase, isFlush);
		};
		options._passiveEffect = (phase, vnode, comp) => {
			passiveEventsA.push(phase);
			prevPassiveEffect(phase, vnode, comp);
		};

		try {
			let bump;
			function SwapDuringCommitAndEffect() {
				const [n, setN] = useState(0);
				bump = () => setN(1);
				useLayoutEffect(() => {
					// Replace _renderPass mid-commit (during render() on mount, during process() on update).
					options._renderPass = (phase, isFlush) => {
						renderPassEventsB.push([phase, isFlush]);
						prevRenderPass(phase, isFlush);
					};
				}, [n]);
				useEffect(() => {
					// Replace _passiveEffect mid-flush.
					options._passiveEffect = (phase, vnode, comp) => {
						passiveEventsB.push(phase);
						prevPassiveEffect(phase, vnode, comp);
					};
				}, [n]);
				return <div>{n}</div>;
			}

			act(() => {
				render(<SwapDuringCommitAndEffect />, scratch);
			});
			// Listener A received both start and end for the mount render() and mount passive flush;
			// Listener B never received an unmatched end event.
			expect(renderPassEventsA).to.deep.equal([
				[0, false],
				[1, false]
			]);
			expect(renderPassEventsB.length % 2).to.equal(0);
			for (let i = 0; i < renderPassEventsB.length; i += 2) {
				expect(renderPassEventsB[i]).to.deep.equal([0, true]);
				expect(renderPassEventsB[i + 1]).to.deep.equal([1, true]);
			}
			expect(passiveEventsA).to.deep.equal([0, 1, 2, 3]);
			expect(passiveEventsB).to.deep.equal([]);

			// Reset back to A before triggering queued process() update so we test mid-process() swap too.
			renderPassEventsA.length = 0;
			renderPassEventsB.length = 0;
			passiveEventsA.length = 0;
			options._renderPass = (phase, isFlush) => {
				renderPassEventsA.push([phase, isFlush]);
				prevRenderPass(phase, isFlush);
			};

			act(() => {
				bump();
			});
			expect(renderPassEventsA).to.deep.equal([
				[0, true],
				[1, true]
			]);
			expect(renderPassEventsB.length % 2).to.equal(0);
			for (let i = 0; i < renderPassEventsB.length; i += 2) {
				expect(renderPassEventsB[i]).to.deep.equal([0, true]);
				expect(renderPassEventsB[i + 1]).to.deep.equal([1, true]);
			}
			expect(passiveEventsB).to.deep.equal([0, 1, 2, 3]);
		} finally {
			options._renderPass = prevRenderPass;
			options._passiveEffect = prevPassiveEffect;
		}
	});
});
