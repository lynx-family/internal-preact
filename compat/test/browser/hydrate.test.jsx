import React, { hydrate } from 'preact/compat';
import { setupScratch, teardown } from '../../../test/_util/helpers';

describe('compat hydrate', () => {
	/** @type {HTMLDivElement} */
	let scratch;

	beforeEach(() => {
		scratch = setupScratch();
	});

	afterEach(() => {
		teardown(scratch);
	});

	// Unrelated to the fork: synchronous `input.focus()` on a manually appended
	// input does not update `document.activeElement` under vitest browser mode
	// (headless chromium). Focus tests in the rest of the suite work because the
	// input is created via `render()` first.
	it.skip('should render react-style jsx', () => {
		const input = document.createElement('input');
		scratch.appendChild(input);
		input.focus();
		expect(document.activeElement).to.equalNode(input);

		hydrate(<input />, scratch);
		expect(document.activeElement).to.equalNode(input);
	});

	it('should call the callback', () => {
		scratch.innerHTML = '<div></div>';

		let spy = sinon.spy();
		hydrate(<div />, scratch, spy);
		expect(spy).to.be.calledOnce;
		expect(spy).to.be.calledWithExactly();
	});
});
