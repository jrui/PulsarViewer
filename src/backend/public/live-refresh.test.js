'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideLiveRefresh, shouldLoadInitialPage } = require('./live-refresh.js');

const MESSAGES_PER_PAGE = 100;

test('decideLiveRefresh: no new messages never refreshes', () => {
  const decision = decideLiveRefresh({
    oldRawCount: 5, newRawCount: 5, currentPage: 0, isSearchActive: false, messagesPerPage: MESSAGES_PER_PAGE
  });
  assert.equal(decision.shouldRefresh, false);
});

// Regression test for the "Clear" bug: after clearing, the raw count resets to 0
// and page 0 becomes the tail page again. Messages arriving one at a time must
// keep refreshing page 0, not just the first one.
test('decideLiveRefresh: refreshes page 0 for every message right after Clear (tail page while count is small)', () => {
  let oldRawCount = 0;
  for (const newRawCount of [1, 2, 3]) {
    const decision = decideLiveRefresh({
      oldRawCount, newRawCount, currentPage: 0, isSearchActive: false, messagesPerPage: MESSAGES_PER_PAGE
    });
    assert.equal(decision.shouldRefresh, true, `expected refresh when count grows ${oldRawCount} -> ${newRawCount}`);
    assert.equal(decision.kind, 'page');
    oldRawCount = newRawCount;
  }
});

test('decideLiveRefresh: does not disrupt an older (non-tail) page once there are multiple pages', () => {
  const decision = decideLiveRefresh({
    oldRawCount: 250, newRawCount: 251, currentPage: 0, isSearchActive: false, messagesPerPage: MESSAGES_PER_PAGE
  });
  assert.equal(decision.shouldRefresh, false);
});

test('decideLiveRefresh: refreshes the last (tail) page when new messages arrive', () => {
  // 250 messages / 100 per page => pages 0,1,2 (tail = page 2)
  const decision = decideLiveRefresh({
    oldRawCount: 250, newRawCount: 251, currentPage: 2, isSearchActive: false, messagesPerPage: MESSAGES_PER_PAGE
  });
  assert.equal(decision.shouldRefresh, true);
  assert.equal(decision.kind, 'page');
});

// Regression test for the "filter doesn't stream" bug: while a search/filter is
// active, new arrivals must always trigger a re-run of the search, regardless
// of which page is being viewed.
test('decideLiveRefresh: refreshes an active search on any page when new messages arrive', () => {
  for (const currentPage of [0, 1, 5]) {
    const decision = decideLiveRefresh({
      oldRawCount: 10, newRawCount: 11, currentPage, isSearchActive: true, messagesPerPage: MESSAGES_PER_PAGE
    });
    assert.equal(decision.shouldRefresh, true, `expected search refresh on page ${currentPage}`);
    assert.equal(decision.kind, 'search');
  }
});

test('shouldLoadInitialPage: true only the first time a non-zero count is seen', () => {
  assert.equal(shouldLoadInitialPage({ initialPageLoaded: false, newRawCount: 1 }), true);
  assert.equal(shouldLoadInitialPage({ initialPageLoaded: true, newRawCount: 1 }), false);
  assert.equal(shouldLoadInitialPage({ initialPageLoaded: false, newRawCount: 0 }), false);
});
