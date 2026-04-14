import { Component } from 'preact';
import { shallowDiffers } from './util';

/**
 * Component class with a predefined `shouldComponentUpdate` implementation
 */
export const PureComponent = /*#__PURE__*/ (function () {
	function _PureComponent(p, c) {
		this.props = p;
		this.context = c;
	}
	_PureComponent.prototype = new Component();
	// Some third-party libraries check if this property is present
	_PureComponent.prototype.isPureReactComponent = true;
	_PureComponent.prototype.shouldComponentUpdate = function (props, state) {
		return (
			shallowDiffers(this.props, props) || shallowDiffers(this.state, state)
		);
	};
	return _PureComponent;
})();
