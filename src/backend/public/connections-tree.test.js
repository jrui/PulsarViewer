'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CT = require('./connections-tree.js');

function conn(id, label, data = {}) {
  return { type: 'connection', id, label, data };
}
function folder(id, name, children = []) {
  return { type: 'folder', id, name, children };
}

// ─── Legacy migration ───────────────────────────────────────────────────────

test('isLegacyFormat: flat label->data object is legacy', () => {
  assert.equal(CT.isLegacyFormat({ Prod: { serviceUrl: 'x' } }), true);
  assert.equal(CT.isLegacyFormat({}), true);
});

test('isLegacyFormat: v2 tree is not legacy', () => {
  assert.equal(CT.isLegacyFormat({ version: 2, root: [] }), false);
});

test('migrateLegacyConnections: preserves key order and data, assigns ids', () => {
  const tree = CT.migrateLegacyConnections({
    Prod: { serviceUrl: 'pulsar://prod', topic: 't1' },
    Dev: { serviceUrl: 'pulsar://dev', topic: 't2' },
  });
  assert.equal(tree.version, 2);
  assert.equal(tree.root.length, 2);
  assert.equal(tree.root[0].label, 'Prod');
  assert.equal(tree.root[1].label, 'Dev');
  assert.deepEqual(tree.root[0].data, { serviceUrl: 'pulsar://prod', topic: 't1' });
  assert.ok(tree.root[0].id && tree.root[1].id && tree.root[0].id !== tree.root[1].id);
  tree.root.forEach(n => assert.equal(n.type, 'connection'));
});

test('normalizeStoredData: null/undefined yields an empty tree', () => {
  assert.deepEqual(CT.normalizeStoredData(null), { version: 2, root: [] });
  assert.deepEqual(CT.normalizeStoredData(undefined), { version: 2, root: [] });
});

test('normalizeStoredData: migrates legacy flat data', () => {
  const tree = CT.normalizeStoredData({ Prod: { serviceUrl: 'x' } });
  assert.equal(tree.root.length, 1);
  assert.equal(tree.root[0].label, 'Prod');
});

test('normalizeStoredData: passes through a well-formed v2 tree unchanged (besides cloning)', () => {
  const input = { version: 2, root: [conn('c1', 'Prod')] };
  const tree = CT.normalizeStoredData(input);
  assert.deepEqual(tree, input);
});

test('serializeTree/deserializeTree round-trip', () => {
  const tree = { version: 2, root: [conn('c1', 'Prod', { serviceUrl: 'x' }), folder('f1', 'Team A', [conn('c2', 'Dev')])] };
  const json = CT.serializeTree(tree);
  const roundTripped = CT.deserializeTree(json);
  assert.deepEqual(roundTripped, tree);
});

test('deserializeTree: invalid JSON yields empty tree', () => {
  assert.deepEqual(CT.deserializeTree('not json'), CT.createEmptyTree());
  assert.deepEqual(CT.deserializeTree(''), CT.createEmptyTree());
});

// ─── Lookups ────────────────────────────────────────────────────────────────

test('findConnectionByLabel: finds root and nested connections', () => {
  const tree = { version: 2, root: [conn('c1', 'Root1'), folder('f1', 'F', [conn('c2', 'Nested1')])] };
  assert.equal(CT.findConnectionByLabel(tree, 'Root1').node.id, 'c1');
  assert.equal(CT.findConnectionByLabel(tree, 'Nested1').node.id, 'c2');
  assert.equal(CT.findConnectionByLabel(tree, 'Nested1').parentId, 'f1');
  assert.equal(CT.findConnectionByLabel(tree, 'Missing'), null);
});

test('findNodeById: finds folders and nested connections, reports parentId', () => {
  const tree = { version: 2, root: [folder('f1', 'F', [conn('c2', 'Nested1')])] };
  assert.equal(CT.findNodeById(tree, 'f1').node.type, 'folder');
  assert.equal(CT.findNodeById(tree, 'f1').parentId, null);
  assert.equal(CT.findNodeById(tree, 'c2').parentId, 'f1');
  assert.equal(CT.findNodeById(tree, 'missing'), null);
});

test('connectionLabelExists / folderNameExists honour excludeId', () => {
  const tree = { version: 2, root: [conn('c1', 'Prod'), folder('f1', 'Team A')] };
  assert.equal(CT.connectionLabelExists(tree, 'Prod'), true);
  assert.equal(CT.connectionLabelExists(tree, 'Prod', 'c1'), false);
  assert.equal(CT.folderNameExists(tree, 'Team A'), true);
  assert.equal(CT.folderNameExists(tree, 'Team A', 'f1'), false);
});

test('getAllConnectionLabels: flattens root + folder children in order', () => {
  const tree = {
    version: 2,
    root: [conn('c1', 'Root1'), folder('f1', 'F', [conn('c2', 'Nested1'), conn('c3', 'Nested2')]), conn('c4', 'Root2')],
  };
  assert.deepEqual(CT.getAllConnectionLabels(tree), ['Root1', 'Nested1', 'Nested2', 'Root2']);
});

// ─── Connection CRUD ────────────────────────────────────────────────────────

test('upsertConnection: appends a new connection to root by default', () => {
  const tree = CT.createEmptyTree();
  const updated = CT.upsertConnection(tree, 'Prod', { serviceUrl: 'x' });
  assert.equal(updated.root.length, 1);
  assert.equal(updated.root[0].label, 'Prod');
  assert.equal(updated.root[0].type, 'connection');
  // original tree is untouched (pure function)
  assert.equal(tree.root.length, 0);
});

test('upsertConnection: appends into a folder when folderId given', () => {
  let tree = CT.createFolder(CT.createEmptyTree(), 'Team A', 'f1');
  tree = CT.upsertConnection(tree, 'Dev', { serviceUrl: 'y' }, { folderId: 'f1' });
  assert.equal(tree.root[0].children.length, 1);
  assert.equal(tree.root[0].children[0].label, 'Dev');
});

test('upsertConnection: updates existing connection data in place, preserving id/position', () => {
  let tree = CT.upsertConnection(CT.createEmptyTree(), 'Prod', { serviceUrl: 'old' });
  const originalId = tree.root[0].id;
  tree = CT.upsertConnection(tree, 'Prod', { serviceUrl: 'new' });
  assert.equal(tree.root.length, 1);
  assert.equal(tree.root[0].id, originalId);
  assert.equal(tree.root[0].data.serviceUrl, 'new');
});

test('removeConnectionByLabel: removes from root or nested folder', () => {
  let tree = CT.upsertConnection(CT.createEmptyTree(), 'Prod', {});
  tree = CT.removeConnectionByLabel(tree, 'Prod');
  assert.equal(tree.root.length, 0);

  tree = CT.createFolder(CT.createEmptyTree(), 'F', 'f1');
  tree = CT.upsertConnection(tree, 'Dev', {}, { folderId: 'f1' });
  tree = CT.removeConnectionByLabel(tree, 'Dev');
  assert.equal(tree.root[0].children.length, 0);
});

test('removeConnectionByLabel: no-op for unknown label', () => {
  const tree = CT.upsertConnection(CT.createEmptyTree(), 'Prod', {});
  const updated = CT.removeConnectionByLabel(tree, 'Missing');
  assert.deepEqual(updated, tree);
});

test('renameConnection: renames by id, no-op for folders or missing ids', () => {
  let tree = CT.upsertConnection(CT.createEmptyTree(), 'Prod', {});
  const id = tree.root[0].id;
  tree = CT.renameConnection(tree, id, 'Production');
  assert.equal(tree.root[0].label, 'Production');

  const folderTree = CT.createFolder(CT.createEmptyTree(), 'F', 'f1');
  assert.deepEqual(CT.renameConnection(folderTree, 'f1', 'X'), folderTree);
  assert.deepEqual(CT.renameConnection(tree, 'missing', 'X'), tree);
});

// ─── Folder CRUD ────────────────────────────────────────────────────────────

test('createFolder / renameFolder', () => {
  let tree = CT.createFolder(CT.createEmptyTree(), 'Team A');
  assert.equal(tree.root.length, 1);
  assert.equal(tree.root[0].type, 'folder');
  assert.equal(tree.root[0].name, 'Team A');
  assert.deepEqual(tree.root[0].children, []);

  const id = tree.root[0].id;
  tree = CT.renameFolder(tree, id, 'Team B');
  assert.equal(tree.root[0].name, 'Team B');
});

test('deleteFolder: promote mode moves children back to root in the folder\'s former position', () => {
  let tree = CT.upsertConnection(CT.createEmptyTree(), 'Before', {});
  tree = CT.createFolder(tree, 'F', 'f1');
  tree = CT.upsertConnection(tree, 'Nested1', {}, { folderId: 'f1' });
  tree = CT.upsertConnection(tree, 'Nested2', {}, { folderId: 'f1' });
  tree = CT.upsertConnection(tree, 'After', {});

  tree = CT.deleteFolder(tree, 'f1', 'promote');
  assert.deepEqual(tree.root.map(n => n.label), ['Before', 'Nested1', 'Nested2', 'After']);
  tree.root.forEach(n => assert.equal(n.type, 'connection'));
});

test('deleteFolder: cascade mode deletes the folder and its children', () => {
  let tree = CT.createFolder(CT.createEmptyTree(), 'F', 'f1');
  tree = CT.upsertConnection(tree, 'Nested1', {}, { folderId: 'f1' });
  tree = CT.deleteFolder(tree, 'f1', 'cascade');
  assert.equal(tree.root.length, 0);
});

test('deleteFolder: no-op for unknown id', () => {
  const tree = CT.createFolder(CT.createEmptyTree(), 'F', 'f1');
  assert.deepEqual(CT.deleteFolder(tree, 'missing', 'promote'), tree);
});

// ─── Moving / reordering ────────────────────────────────────────────────────

test('moveNode: reorder within root moving forward (target index counted before removal)', () => {
  const tree = { version: 2, root: [conn('c1', 'A'), conn('c2', 'B'), conn('c3', 'C')] };
  // targetIndex=2 means "insert before whatever currently sits at index 2" (C),
  // which lands A between B and C once it's removed from index 0.
  const updated = CT.moveNode(tree, 'c1', null, 2);
  assert.deepEqual(updated.root.map(n => n.id), ['c2', 'c1', 'c3']);
});

test('moveNode: reorder within root moving to the very end', () => {
  const tree = { version: 2, root: [conn('c1', 'A'), conn('c2', 'B'), conn('c3', 'C')] };
  // targetIndex === original container length moves the node past the last element.
  const updated = CT.moveNode(tree, 'c1', null, 3);
  assert.deepEqual(updated.root.map(n => n.id), ['c2', 'c3', 'c1']);
});

test('moveNode: reorder within root moving backward', () => {
  const tree = { version: 2, root: [conn('c1', 'A'), conn('c2', 'B'), conn('c3', 'C')] };
  const updated = CT.moveNode(tree, 'c3', null, 0);
  assert.deepEqual(updated.root.map(n => n.id), ['c3', 'c1', 'c2']);
});

test('moveNode: move connection from root into a folder', () => {
  const tree = { version: 2, root: [conn('c1', 'A'), folder('f1', 'F', [])] };
  const updated = CT.moveNode(tree, 'c1', 'f1', 0);
  assert.equal(updated.root.length, 1);
  assert.equal(updated.root[0].children[0].id, 'c1');
});

test('moveNode: move connection out of a folder back to root at a given index', () => {
  const tree = { version: 2, root: [conn('c0', 'Zero'), folder('f1', 'F', [conn('c1', 'A')])] };
  const updated = CT.moveNode(tree, 'c1', null, 0);
  assert.deepEqual(updated.root.map(n => n.id), ['c1', 'c0', 'f1']);
  assert.equal(updated.root[2].children.length, 0);
});

test('moveNode: move connection from one folder to another', () => {
  const tree = {
    version: 2,
    root: [folder('f1', 'F1', [conn('c1', 'A')]), folder('f2', 'F2', [conn('c2', 'B')])],
  };
  const updated = CT.moveNode(tree, 'c1', 'f2', 1);
  assert.equal(updated.root[0].children.length, 0);
  assert.deepEqual(updated.root[1].children.map(n => n.id), ['c2', 'c1']);
});

test('moveNode: reorder connections within the same folder', () => {
  const tree = { version: 2, root: [folder('f1', 'F', [conn('c1', 'A'), conn('c2', 'B'), conn('c3', 'C')])] };
  const updated = CT.moveNode(tree, 'c3', 'f1', 0);
  assert.deepEqual(updated.root[0].children.map(n => n.id), ['c3', 'c1', 'c2']);
});

test('moveNode: folders cannot be moved into another folder (no-op)', () => {
  const tree = { version: 2, root: [folder('f1', 'F1', []), folder('f2', 'F2', [])] };
  const updated = CT.moveNode(tree, 'f1', 'f2', 0);
  assert.deepEqual(updated, tree);
});

test('moveNode: reorder folders within root', () => {
  const tree = { version: 2, root: [folder('f1', 'F1', []), folder('f2', 'F2', []), conn('c1', 'A')] };
  const updated = CT.moveNode(tree, 'f2', null, 0);
  assert.deepEqual(updated.root.map(n => n.id), ['f2', 'f1', 'c1']);
});

test('moveNode: unknown nodeId or target folder is a no-op', () => {
  const tree = { version: 2, root: [conn('c1', 'A')] };
  assert.deepEqual(CT.moveNode(tree, 'missing', null, 0), tree);
  assert.deepEqual(CT.moveNode(tree, 'c1', 'missing-folder', 0), tree);
});

// ─── Import merge ───────────────────────────────────────────────────────────

test('mergeTrees: adds non-conflicting connections and folders', () => {
  const existing = { version: 2, root: [conn('c1', 'Prod', { a: 1 })] };
  const incoming = {
    version: 2,
    root: [conn('c2', 'Dev', { b: 2 }), folder('f1', 'Imported', [conn('c3', 'Staging', { c: 3 })])],
  };
  const merged = CT.mergeTrees(existing, incoming, true);
  assert.equal(CT.getAllConnectionLabels(merged).sort().join(','), 'Dev,Prod,Staging');
  const importedFolder = merged.root.find(n => n.type === 'folder');
  assert.equal(importedFolder.name, 'Imported');
  assert.equal(importedFolder.children[0].label, 'Staging');
  // Imported folder gets a fresh id, not reused from the incoming tree, to avoid collisions.
  assert.notEqual(importedFolder.id, 'f1');
});

test('mergeTrees: skips conflicting labels when overwriteConflicts is false', () => {
  const existing = { version: 2, root: [conn('c1', 'Prod', { a: 1 })] };
  const incoming = { version: 2, root: [conn('c2', 'Prod', { a: 2 })] };
  const merged = CT.mergeTrees(existing, incoming, false);
  assert.equal(merged.root.length, 1);
  assert.deepEqual(merged.root[0].data, { a: 1 });
});

test('mergeTrees: overwrites conflicting connection data in place when overwriteConflicts is true', () => {
  const existing = { version: 2, root: [folder('f1', 'F', [conn('c1', 'Prod', { a: 1 })])] };
  const incoming = { version: 2, root: [conn('c2', 'Prod', { a: 2 })] };
  const merged = CT.mergeTrees(existing, incoming, true);
  assert.equal(merged.root.length, 1);
  assert.equal(merged.root[0].type, 'folder');
  assert.equal(merged.root[0].children[0].data.a, 2);
  assert.equal(merged.root[0].children[0].id, 'c1'); // position/id preserved
});

test('mergeTrees: legacy flat import (normalized first) merges connections at root', () => {
  const existing = CT.createEmptyTree();
  const incoming = CT.normalizeStoredData({ Prod: { serviceUrl: 'x' } });
  const merged = CT.mergeTrees(existing, incoming, true);
  assert.deepEqual(CT.getAllConnectionLabels(merged), ['Prod']);
});
