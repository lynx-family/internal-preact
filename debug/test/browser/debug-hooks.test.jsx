import { createElement, render, Component, options } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import 'preact/debug';
import { act, teardown as teardownAct } from 'preact/test-utils';
import { setupScratch, teardown } from '../../../test/_util/helpers';
import { vi } from 'vitest';

describe('debug with hooks', () => {
	let scratch;
	let errors = [];
	let warnings = [];

	beforeEach(() => {
		errors = [];
		warnings = [];
		scratch = setupScratch();
		vi.spyOn(console, 'error').mockImplementation(e => errors.push(e));
		vi.spyOn(console, 'warn').mockImplementation(w => warnings.push(w));
	});

	afterEach(() => {
		console.error.mockRestore();
		console.warn.mockRestore();
		teardown(scratch);
	});

	it('should throw an error when using a hook outside a render', () => {
		class Foo extends Component {
			componentWillMount() {
				useState();
			}

			render() {
				return this.props.children;
			}
		}

		class App extends Component {
			render() {
				return <p>test</p>;
			}
		}
		const fn = () =>
			act(() =>
				render(
					<Foo>
						<App />
					</Foo>,
					scratch
				)
			);
		expect(fn).to.throw(/Hook can only be invoked from render/);
	});

	it('should throw an error when invoked outside of a component', () => {
		function foo() {
			useEffect(() => {}); // Pretend to use a hook
			return <p>test</p>;
		}

		const fn = () =>
			act(() => {
				render(foo(), scratch);
			});
		expect(fn).to.throw(/Hook can only be invoked from render/);
	});

	it('should throw an error when invoked outside of a component before render', () => {
		function Foo(props) {
			useEffect(() => {}); // Pretend to use a hook
			return props.children;
		}

		const fn = () =>
			act(() => {
				useState();
				render(<Foo>Hello!</Foo>, scratch);
			});
		expect(fn).to.throw(/Hook can only be invoked from render/);
	});

	it('should throw an error when invoked outside of a component after render', () => {
		function Foo(props) {
			useEffect(() => {}); // Pretend to use a hook
			return props.children;
		}

		const fn = () =>
			act(() => {
				render(<Foo>Hello!</Foo>, scratch);
				useState();
			});
		expect(fn).to.throw(/Hook can only be invoked from render/);
	});

	it('should throw an error when invoked inside an effect callback', () => {
		function Foo(props) {
			useEffect(() => {
				useState();
			});
			return props.children;
		}

		const fn = () =>
			act(() => {
				render(<Foo>Hello!</Foo>, scratch);
			});
		expect(fn).to.throw(/Hook can only be invoked from render/);
	});

	describe('passive effect update depth', () => {
		it('does not warn at 50 consecutive passive updates and warns on the 51st', () => {
			function Counter({ limit }) {
				const [count, setCount] = useState(0);
				useEffect(() => {
					if (count < limit) {
						setCount(count + 1);
					}
				}, [count]);
				return <span>{count}</span>;
			}

			function App({ limit }) {
				return <Counter limit={limit} />;
			}

			act(() => render(<App limit={50} />, scratch));
			expect(scratch.textContent).to.equal('50');
			expect(errors).to.deep.equal([]);

			act(() => render(null, scratch));

			act(() => render(<App limit={51} />, scratch));
			expect(scratch.textContent).to.equal('51');
			expect(errors).to.have.lengthOf(1);
			expect(errors[0]).to.include('Maximum update depth exceeded');
			expect(errors[0]).to.match(/in Counter[\s\S]*in App/);
		});

		it('warns on a bounded 100-pass self-update loop scheduled via microtasks and keeps updating', async () => {
			teardownAct();
			const prevRaf = options.requestAnimationFrame;
			options.requestAnimationFrame = queueMicrotask;

			try {
				function Counter() {
					const [count, setCount] = useState(0);
					useEffect(() => {
						if (count < 100) {
							setCount(count + 1);
						}
					}, [count]);
					return <span>{count}</span>;
				}

				function App() {
					return <Counter />;
				}

				render(<App />, scratch);

				for (let i = 0; i < 300 && scratch.textContent !== '100'; i++) {
					await new Promise(resolve => queueMicrotask(resolve));
				}

				expect(scratch.textContent).to.equal('100');
				expect(errors).to.have.lengthOf(1);
				expect(errors[0]).to.include('Maximum update depth exceeded');
				expect(errors[0]).to.match(/in Counter[\s\S]*in App/);
			} finally {
				options.requestAnimationFrame = prevRaf;
				render(null, scratch);
				await new Promise(resolve => queueMicrotask(resolve));
			}
		});

		it('warns when two components under one root update each other repeatedly', () => {
			let kickA;
			let kickB;

			function CompA({ limit }) {
				const [turn, setTurn] = useState(0);
				kickA = setTurn;
				useEffect(() => {
					if (turn < limit) {
						kickB(turn + 1);
					}
				}, [turn]);
				return <span>A:{turn}</span>;
			}

			function CompB({ limit }) {
				const [turn, setTurn] = useState(0);
				kickB = setTurn;
				useEffect(() => {
					if (turn > 0 && turn < limit) {
						kickA(turn + 1);
					}
				}, [turn]);
				return <span>B:{turn}</span>;
			}

			function App({ limit }) {
				return (
					<div>
						<section>
							<CompA limit={limit} />
						</section>
						<article>
							<CompB limit={limit} />
						</article>
					</div>
				);
			}

			act(() => render(<App limit={60} />, scratch));
			expect(scratch.textContent).to.equal('A:60B:59');
			expect(errors).to.have.lengthOf(1);
			expect(errors[0]).to.include('Maximum update depth exceeded');
			expect(errors[0]).to.match(/in (CompA|CompB)[\s\S]*in App/);
		});

		it('tracks updates from passive cleanups and ignores setters on unmounted components', () => {
			function RemountingChild({ step, onCleanup }) {
				useEffect(() => () => onCleanup(step), [step]);
				return <span>{step}</span>;
			}

			let kick;
			function CleanupLoopApp() {
				const [count, setCount] = useState(0);
				kick = () => setCount(1);
				return (
					<RemountingChild
						key={count}
						step={count}
						onCleanup={step => {
							if (step < 54) {
								setCount(c => c + 1);
							}
						}}
					/>
				);
			}

			act(() => render(<CleanupLoopApp />, scratch));
			act(() => kick());
			expect(scratch.textContent).to.equal('55');
			expect(errors).to.have.lengthOf(1);
			expect(errors[0]).to.include('Maximum update depth exceeded');
			expect(errors[0]).to.match(/in RemountingChild[\s\S]*in CleanupLoopApp/);

			errors.length = 0;
			act(() => render(null, scratch));

			function UnmountedSelfUpdater({ step }) {
				const [, setLocal] = useState(0);
				useEffect(() => () => setLocal(v => v + 1), []);
				return <span>{step}</span>;
			}

			for (let i = 0; i < 60; i++) {
				act(() => render(<UnmountedSelfUpdater key={i} step={i} />, scratch));
			}
			expect(errors).to.deep.equal([]);
		});

		it('does not count same-value updates that bail out', () => {
			function SameValueApp({ tick }) {
				const [value, setValue] = useState(0);
				useEffect(() => {
					setValue(0);
				}, [tick]);
				return <span>{value}</span>;
			}

			for (let i = 0; i < 60; i++) {
				act(() => render(<SameValueApp tick={i} />, scratch));
			}
			expect(errors).to.deep.equal([]);
		});

		it('counts at most once per root per batch when multiple setters or components update', () => {
			function MultiSetter() {
				const [a, setA] = useState(0);
				const [b, setB] = useState(0);
				const [c, setC] = useState(0);

				useEffect(() => {
					if (a < 30) {
						setA(v => v + 1);
						setB(v => v + 1);
						setC(v => v + 1);
					}
				}, [a]);

				return (
					<span>
						{a}-{b}-{c}
					</span>
				);
			}

			act(() => render(<MultiSetter />, scratch));
			expect(scratch.textContent).to.equal('30-30-30');
			expect(errors).to.deep.equal([]);

			act(() => render(null, scratch));

			// Distinct sibling components each inserting into rerenderQueue in the
			// same passive batch (20 batches * 4 components = 80 queue insertions).
			function SiblingWorker({ id }) {
				const [step, setStep] = useState(0);
				useEffect(() => {
					if (step < 20) {
						setStep(s => s + 1);
					}
				}, [step]);
				return (
					<span>
						{id}:{step};
					</span>
				);
			}

			function MultiComponentBatchApp() {
				return (
					<div>
						<SiblingWorker id="a" />
						<SiblingWorker id="b" />
						<SiblingWorker id="c" />
						<SiblingWorker id="d" />
					</div>
				);
			}

			act(() => render(<MultiComponentBatchApp />, scratch));
			expect(scratch.textContent).to.equal('a:20;b:20;c:20;d:20;');
			expect(errors).to.deep.equal([]);
		});

		it('resets the streak after an idle passive batch or tree unmount', () => {
			let bump;
			function ResettableLoop() {
				const [count, setCount] = useState(0);
				const [shouldLoop, setShouldLoop] = useState(true);
				bump = () => {
					setShouldLoop(true);
					setCount(c => c + 1);
				};

				useEffect(() => {
					if (!shouldLoop) return;
					if (count === 40) {
						setShouldLoop(false);
					} else if (count < 85) {
						setCount(c => c + 1);
					}
				}, [count, shouldLoop]);

				return <span>{count}</span>;
			}

			act(() => render(<ResettableLoop />, scratch));
			// At count === 40, one update flips shouldLoop to false (batch 41),
			// then the next passive batch sees !shouldLoop and schedules nothing (reset).
			expect(scratch.textContent).to.equal('40');
			act(() => bump());
			// Continues for 44 more batches (41 -> 85) without exceeding 50 consecutively.
			expect(scratch.textContent).to.equal('85');
			expect(errors).to.deep.equal([]);

			// Unmount reset check
			function Bounded({ limit }) {
				const [count, setCount] = useState(0);
				useEffect(() => {
					if (count < limit) setCount(c => c + 1);
				}, [count]);
				return <span>{count}</span>;
			}

			act(() => render(<Bounded limit={40} />, scratch));
			expect(scratch.textContent).to.equal('40');
			act(() => render(null, scratch));
			act(() => render(<Bounded limit={40} />, scratch));
			expect(scratch.textContent).to.equal('40');
			expect(errors).to.deep.equal([]);
		});

		it('counts pending passive effects flushed synchronously before render without premature reset', () => {
			teardownAct();
			const prevRaf = options.requestAnimationFrame;
			const scheduledFlushes = [];
			options.requestAnimationFrame = cb => scheduledFlushes.push(cb);

			try {
				function SyncFlushedChild() {
					const [count, setCount] = useState(0);
					useEffect(() => {
						setCount(c => c + 1);
					});
					return <span>{count}</span>;
				}

				function App({ tick }) {
					return <SyncFlushedChild tick={tick} />;
				}

				// First render queues SyncFlushedChild's effect; subsequent renders
				// flush the previous pending effect synchronously inside options._render.
				for (let i = 0; i <= 40; i++) {
					render(<App tick={i} />, scratch);
				}
				expect(errors).to.deep.equal([]);

				// Draining afterPaintEffects encounters 1 active flush plus 39 stale
				// queue entries whose _pendingEffects were already consumed before render.
				// Skipping empty entries must keep the 41-update streak intact.
				while (scheduledFlushes.length) {
					const cb = scheduledFlushes.shift();
					cb();
				}
				expect(errors).to.deep.equal([]);

				for (let i = 41; i <= 51; i++) {
					render(<App tick={i} />, scratch);
				}
				expect(errors).to.have.lengthOf(1);
				expect(errors[0]).to.include('Maximum update depth exceeded');
				expect(errors[0]).to.match(/in SyncFlushedChild[\s\S]*in App/);
			} finally {
				options.requestAnimationFrame = prevRaf;
				render(null, scratch);
				while (scheduledFlushes.length) {
					scheduledFlushes.shift()();
				}
			}
		});

		it('isolates streaks across independent roots and ignores cross-root updates', () => {
			const scratch2 = document.createElement('div');
			document.body.appendChild(scratch2);

			try {
				function SelfLoop({ limit }) {
					const [count, setCount] = useState(0);
					useEffect(() => {
						if (count < limit) setCount(c => c + 1);
					}, [count]);
					return <span>{count}</span>;
				}

				// 35 + 35 = 70 total updates across two roots: no warning
				act(() => {
					render(<SelfLoop limit={35} />, scratch);
					render(<SelfLoop limit={35} />, scratch2);
				});
				expect(scratch.textContent).to.equal('35');
				expect(scratch2.textContent).to.equal('35');
				expect(errors).to.deep.equal([]);

				act(() => {
					render(null, scratch);
					render(null, scratch2);
				});

				// Cross-root ping-pong (60 passes): outside single-root loop scope
				let setRoot1;
				let setRoot2;

				function Root1() {
					const [turn, setTurn] = useState(0);
					setRoot1 = setTurn;
					useEffect(() => {
						if (turn < 60) setRoot2(turn + 1);
					}, [turn]);
					return <span>{turn}</span>;
				}

				function Root2() {
					const [turn, setTurn] = useState(0);
					setRoot2 = setTurn;
					useEffect(() => {
						if (turn > 0 && turn < 60) setRoot1(turn + 1);
					}, [turn]);
					return <span>{turn}</span>;
				}

				act(() => {
					render(<Root2 />, scratch2);
					render(<Root1 />, scratch);
				});
				expect(scratch.textContent).to.equal('60');
				expect(scratch2.textContent).to.equal('59');
				expect(errors).to.deep.equal([]);

				act(() => {
					render(null, scratch);
					render(null, scratch2);
				});

				// Idle batch on scratch2 mid-loop does not reset scratch1's streak
				let idleTick2;
				function IdleRoot2() {
					const [v, setV] = useState(0);
					idleTick2 = () => setV(c => c + 1);
					useEffect(() => {}, [v]);
					return <span>{v}</span>;
				}

				function CheckedRoot1() {
					const [count, setCount] = useState(0);
					useEffect(() => {
						if (count === 25) idleTick2();
						if (count < 55) setCount(c => c + 1);
					}, [count]);
					return <span>{count}</span>;
				}

				act(() => {
					render(<IdleRoot2 />, scratch2);
					render(<CheckedRoot1 />, scratch);
				});
				expect(scratch.textContent).to.equal('55');
				expect(errors).to.have.lengthOf(1);
				expect(errors[0]).to.include('Maximum update depth exceeded');
			} finally {
				act(() => render(null, scratch2));
				scratch2.remove();
			}
		});

		it('recovers stacks when an effect throws and resets when unmounted inside an effect', () => {
			class Boundary extends Component {
				constructor(props) {
					super(props);
					this.state = { hasError: false };
				}
				componentDidCatch() {
					this.setState({ hasError: true });
				}
				render() {
					return this.state.hasError ? (
						<span>caught</span>
					) : (
						this.props.children
					);
				}
			}

			function ThrowInEffect() {
				useEffect(() => {
					throw new Error('boom');
				}, []);
				return <span>ok</span>;
			}

			act(() =>
				render(
					<Boundary>
						<ThrowInEffect />
					</Boundary>,
					scratch
				)
			);
			expect(scratch.textContent).to.equal('caught');

			errors.length = 0;
			act(() => render(null, scratch));

			function Loop({ limit, unmountAt }) {
				const [count, setCount] = useState(0);
				useEffect(() => {
					if (unmountAt != null && count === unmountAt) {
						setCount(c => c + 1);
						render(null, scratch);
						return;
					}
					if (count < limit) setCount(c => c + 1);
				}, [count]);
				return <span>{count}</span>;
			}

			// Stack recovered cleanly: exact 51-update threshold still triggers.
			act(() => render(<Loop limit={51} />, scratch));
			expect(errors).to.have.lengthOf(1);
			expect(errors[0]).to.include('Maximum update depth exceeded');

			errors.length = 0;
			act(() => render(null, scratch));

			// Unmounting inside an effect after scheduling an update resets streak.
			act(() => render(<Loop limit={40} unmountAt={40} />, scratch));
			act(() => render(<Loop limit={40} />, scratch));
			expect(errors).to.deep.equal([]);
		});

		it('shares a single batch across sibling pre-render passive flushes in one render pass', () => {
			teardownAct();
			const prevRaf = options.requestAnimationFrame;
			const prevDebounce = options.debounceRendering;
			const scheduledFlushes = [];
			let drainQueue;
			options.requestAnimationFrame = cb => scheduledFlushes.push(cb);
			options.debounceRendering = cb => {
				drainQueue = cb;
			};

			try {
				const setters = [];
				function SiblingItem({ index, step }) {
					const [ready, setReady] = useState(false);
					const [, setBump] = useState(0);
					setters[index] = () => setBump(v => v + 1);
					useEffect(() => {
						setReady(true);
					}, []);
					return (
						<span>
							{step}:{ready ? '1' : '0'}
						</span>
					);
				}

				function SiblingList({ step }) {
					const items = [];
					for (let i = 0; i < 55; i++) {
						items.push(<SiblingItem key={i} index={i} step={step} />);
					}
					return <div>{items}</div>;
				}

				// 1) Synchronous second render() before afterPaint: 55 siblings flush
				// their mount effect in one render pass -> counts once, not 55 times.
				render(<SiblingList step={0} />, scratch);
				render(<SiblingList step={1} />, scratch);
				while (scheduledFlushes.length) scheduledFlushes.shift()();
				if (drainQueue) drainQueue();
				expect(errors).to.deep.equal([]);

				render(null, scratch);
				while (scheduledFlushes.length) scheduledFlushes.shift()();

				// 2) Individually dirtied siblings drained in one process() pass before
				// afterPaint runs -> also shares a single render-pass batch.
				render(<SiblingList step={0} />, scratch);
				for (let i = 0; i < 55; i++) {
					setters[i]();
				}
				if (drainQueue) drainQueue();
				while (scheduledFlushes.length) scheduledFlushes.shift()();
				if (drainQueue) drainQueue();
				expect(errors).to.deep.equal([]);

				render(null, scratch);
				while (scheduledFlushes.length) scheduledFlushes.shift()();

				// 3) An idle sibling in the same pre-render pass does not reset an
				// active pre-render loop on the same root.
				function IdleSibling({ tick }) {
					useEffect(() => {}, [tick]);
					return null;
				}
				function LoopingSibling() {
					const [count, setCount] = useState(0);
					useEffect(() => {
						setCount(c => c + 1);
					});
					return <span>{count}</span>;
				}
				function MixedPreRenderApp({ tick }) {
					return (
						<div>
							<LoopingSibling tick={tick} />
							<IdleSibling tick={tick} />
						</div>
					);
				}

				for (let i = 0; i <= 51; i++) {
					render(<MixedPreRenderApp tick={i} />, scratch);
				}
				expect(errors).to.have.lengthOf(1);
				expect(errors[0]).to.include('Maximum update depth exceeded');
			} finally {
				options.requestAnimationFrame = prevRaf;
				options.debounceRendering = prevDebounce;
				render(null, scratch);
				while (scheduledFlushes.length) scheduledFlushes.shift()();
				if (drainQueue) drainQueue();
			}
		});

		it('resets the streak when follow-up renders settle without scheduling new passive effects', async () => {
			function SyncedProp({ value }) {
				const [local, setLocal] = useState(value);
				useEffect(() => {
					setLocal(value);
				}, [value]);
				return <span>{local}</span>;
			}

			// 55 sequential prop changes under act(), each settling completely.
			act(() => render(<SyncedProp value={0} />, scratch));
			for (let i = 1; i <= 55; i++) {
				act(() => render(<SyncedProp value={i} />, scratch));
				expect(scratch.textContent).to.equal(String(i));
			}
			expect(errors).to.deep.equal([]);

			act(() => render(null, scratch));

			// Also verify under real microtask scheduling (matching Lynx background runtime).
			teardownAct();
			const prevRaf = options.requestAnimationFrame;
			options.requestAnimationFrame = queueMicrotask;
			try {
				render(<SyncedProp value={0} />, scratch);
				await new Promise(resolve => setTimeout(resolve, 0));

				for (let i = 1; i <= 55; i++) {
					render(<SyncedProp value={i} />, scratch);
					for (
						let tick = 0;
						tick < 10 && scratch.textContent !== String(i);
						tick++
					) {
						await new Promise(resolve => queueMicrotask(resolve));
					}
					await new Promise(resolve => queueMicrotask(resolve));
					expect(scratch.textContent).to.equal(String(i));
				}
				expect(errors).to.deep.equal([]);
			} finally {
				options.requestAnimationFrame = prevRaf;
				render(null, scratch);
				await new Promise(resolve => queueMicrotask(resolve));
			}
		});
	});
});
