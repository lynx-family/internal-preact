import { createElement, render } from 'preact';
import { useState } from 'preact/hooks';
import { setupScratch, teardown } from '../_util/helpers';

/**
 * Measures how the cost of unmounting a whole tree scales with its depth.
 *
 * The leaf count is fixed, so depth is the only variable. Anything that makes
 * the deeper runs slower is per-component work proportional to the distance to
 * the root.
 *
 * `options.unmount` gained such a walk in 46ddd2f91, looking for the nearest
 * still-mounted ancestor to route deferred cleanup errors to:
 *
 *     let errorParent = vnode._parent;
 *     while (errorParent && !(errorParent._component && errorParent._component._parentDom)) {
 *       errorParent = errorParent._parent;
 *     }
 *
 * `unmount()` clears `_parentDom` on its way down, so during a full unmount
 * every ancestor already fails that test and the walk runs to the root.
 */
describe('unmount cost vs tree depth', () => {
	/** @type {HTMLDivElement} */
	let scratch;

	// Enough leaves to lift the measurement above timer resolution. At 2000 the
	// whole unmount takes ~0.1ms and every depth reads the same.
	const LEAF_COUNT = 20000;

	beforeEach(() => {
		scratch = setupScratch();
	});

	afterEach(() => {
		teardown(scratch);
	});

	// One stateful hook, so `options.unmount` has a hook list to walk.
	function Leaf() {
		useState(0);
		return createElement('div', null);
	}

	// `depth` nested components wrapping the leaves.
	function nest(depth, children) {
		if (depth === 0) return children;
		function Wrapper() {
			return nest(depth - 1, children);
		}
		return createElement(Wrapper, null);
	}

	function measureUnmount(depth) {
		const leaves = [];
		for (let i = 0; i < LEAF_COUNT; i++) {
			leaves.push(createElement(Leaf, { key: i }));
		}

		render(nest(depth, leaves), scratch);
		expect(scratch.querySelectorAll('div').length).to.equal(LEAF_COUNT);

		const start = performance.now();
		render(null, scratch);
		const elapsed = performance.now() - start;

		expect(scratch.querySelectorAll('div').length).to.equal(0);
		return elapsed;
	}

	it('unmounts the same leaves at several depths', () => {
		const DEPTHS = [1, 10, 30, 60];
		const results = [];

		for (const depth of DEPTHS) {
			measureUnmount(depth); // warm up
			// Fastest of several runs: the slow ones carry GC and scheduling
			// noise, the fastest is the closest to the work actually done.
			let best = Infinity;
			for (let i = 0; i < 9; i++) best = Math.min(best, measureUnmount(depth));
			results.push({ depth, best });
		}

		const base = results[0].best;
		const report = results
			.map(
				r =>
					`  depth ${String(r.depth).padStart(2)}: ` +
					`${r.best.toFixed(2)}ms  (${(r.best / base).toFixed(2)}x)`
			)
			.join('\n');

		// eslint-disable-next-line no-console
		console.log(`unmount of ${LEAF_COUNT} leaves:\n${report}`);

		expect(results.length).to.equal(DEPTHS.length);
	});
});
