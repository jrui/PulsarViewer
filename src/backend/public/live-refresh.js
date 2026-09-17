// Pure decision logic for keeping the consumer message view live as new
// messages arrive over SSE. Deliberately free of DOM/fetch/timer side effects
// so it can be unit tested (see live-refresh.test.js) without a browser.
//
// Loaded as a plain classic script in the browser (exposes
// `window.PulsarViewerLiveRefresh`) and as a CommonJS module under Node's
// test runner.
(function (root) {
  // Decide whether the currently visible page (normal browsing) or the
  // currently active search should be re-fetched now that the backend's raw
  // message count has grown from oldRawCount to newRawCount.
  //
  // While searching, results always refresh on new arrivals (a match may
  // have just been produced). While browsing normally, only the "tail" page
  // — the page that would receive newly appended messages — refreshes, so
  // a user reading an older page isn't disrupted.
  function decideLiveRefresh({ oldRawCount, newRawCount, currentPage, isSearchActive, messagesPerPage }) {
    if (!(newRawCount > oldRawCount)) return { shouldRefresh: false };
    if (isSearchActive) return { shouldRefresh: true, kind: 'search' };
    const oldTotalPages = Math.max(Math.ceil(oldRawCount / messagesPerPage), 1);
    const isTailPage = currentPage >= oldTotalPages - 1;
    return { shouldRefresh: isTailPage, kind: 'page' };
  }

  // Decide whether the very first page/search load should happen now that a
  // stats event reports a non-zero backend message count.
  function shouldLoadInitialPage({ initialPageLoaded, newRawCount }) {
    return !initialPageLoaded && newRawCount > 0;
  }

  const api = { decideLiveRefresh, shouldLoadInitialPage };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PulsarViewerLiveRefresh = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
