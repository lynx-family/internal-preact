import {
	createElement,
	Component,
	createContext,
	options,
	render
} from 'preact';
import { setupRerender } from 'preact/test-utils';
import { setupScratch, teardown } from '../../_util/helpers';

it('remounts a scheduled component when Fast Refresh resolves a new type', () => {
	const scratch = setupScratch();
	const rerender = setupRerender();
	const originalResolver = options._resolveRefreshType;
	const lifecycle = [];
	const refValues = [];
	const context = createContext('default');
	let notifyOldInstance;
	let wrapper;

	class Wrapper extends Component {
		componentDidMount() {
			wrapper = this;
		}
		render(props) {
			return props.children;
		}
	}

	class OldCounter extends Component {
		componentDidMount() {
			lifecycle.push('mount old');
			notifyOldInstance = () => this.setState({ stale: true });
		}
		componentWillUnmount() {
			lifecycle.push('unmount old');
		}
		render() {
			return <span>old</span>;
		}
	}

	class NewCounter extends Component {
		static contextType = context;

		componentDidMount() {
			lifecycle.push('mount new');
		}
		render() {
			return [<span>{this.context}</span>, <span>new</span>];
		}
	}

	function FunctionCounter(props) {
		return <span ref={props.ref}>function</span>;
	}

	try {
		const counter = <OldCounter />;
		counter.ref = instance => {
			refValues.push(instance);
		};
		render(
			<context.Provider value="provided">
				<b>before</b>
				<Wrapper>{counter}</Wrapper>
				<i>after</i>
			</context.Provider>,
			scratch
		);
		const [oldInstance] = refValues;
		const before = scratch.firstChild;
		const after = scratch.lastChild;

		options._resolveRefreshType = type =>
			type === OldCounter ? NewCounter : type;
		oldInstance.forceUpdate();
		rerender();
		notifyOldInstance();
		wrapper.forceUpdate();
		rerender();

		expect(lifecycle).to.deep.equal(['mount old', 'unmount old', 'mount new']);
		expect(refValues[1]).to.equal(null);
		expect(refValues[2]).to.be.instanceOf(NewCounter);
		expect(scratch.textContent).to.equal('beforeprovidednewafter');
		expect(scratch.firstChild).to.equal(before);
		expect(scratch.lastChild).to.equal(after);

		options._resolveRefreshType = type =>
			type === OldCounter || type === NewCounter ? FunctionCounter : type;
		refValues[2].forceUpdate();
		rerender();
		expect(refValues[3]).to.equal(null);
		expect(refValues[4]).to.be.instanceOf(HTMLSpanElement);
		expect(scratch.textContent).to.equal('beforefunctionafter');
	} finally {
		options._resolveRefreshType = originalResolver;
		teardown(scratch);
	}
});
