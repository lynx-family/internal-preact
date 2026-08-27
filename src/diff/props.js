/**
 * Set a property value on a DOM node.
 * Lynx: the host runtime's fake DOM routes every prop through
 * `setAttribute` (SnapshotInstance keeps its own indexed/extra prop
 * stores), so the upstream style/event/attribute machinery is unused.
 * @param {import('../internal').PreactElement} dom The DOM node to modify
 * @param {string} name The name of the property to set
 * @param {*} value The value to set the property to
 * @param {*} oldValue The old value the property had
 * @param {string} namespace Whether or not this DOM node is an SVG node or not
 */
export function setProperty(dom, name, value, oldValue, namespace) {
	dom.setAttribute(name, value);
}
