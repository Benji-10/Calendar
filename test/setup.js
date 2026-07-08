/* jsdom shims for browser APIs the app touches */
if (!window.storage) window.storage = { get: async () => null, set: async () => ({}) };
if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
if (!global.fetch) global.fetch = async () => ({ ok: true, json: async () => [] });
if (!window.requestAnimationFrame) window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
