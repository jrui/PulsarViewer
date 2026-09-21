// Pure data-structure helpers for organizing saved connections into a
// single-level tree of folders + connections (folders do NOT nest).
// Deliberately free of DOM/localStorage/confirm() side effects so it can be
// unit tested (see connections-tree.test.js) without a browser.
//
// Loaded as a plain classic script in the browser (exposes
// `window.PulsarViewerConnectionsTree`) and as a CommonJS module under
// Node's test runner.
//
// Tree shape (version 2):
//   { version: 2, root: Array<FolderNode | ConnectionNode> }
//   FolderNode:     { type: 'folder', id, name, children: ConnectionNode[] }
//   ConnectionNode: { type: 'connection', id, label, data }
//
// Legacy shape (pre-folders): a flat object `{ [label]: data }`, migrated
// in-place into root-level connection nodes (existing key order preserved).
(function (root) {
  const TREE_VERSION = 2;

  function generateId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createEmptyTree() {
    return { version: TREE_VERSION, root: [] };
  }

  // A parsed value is "legacy" if it isn't already a recognizable v2 tree
  // (i.e. it doesn't have a `root` array under version 2). This includes
  // `{}` (no connections yet), which migrates to an empty tree.
  function isLegacyFormat(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (parsed.version === TREE_VERSION && Array.isArray(parsed.root)) return false;
    return true;
  }

  function migrateLegacyConnections(flatObj) {
    const root = Object.keys(flatObj || {}).map(label => ({
      type: 'connection',
      id: generateId('c'),
      label,
      data: flatObj[label],
    }));
    return { version: TREE_VERSION, root };
  }

  // Accepts the already-JSON-parsed value read from storage (or `null`/
  // `undefined` when nothing has been saved yet) and returns a valid v2 tree,
  // migrating legacy flat data as needed.
  function normalizeStoredData(raw) {
    if (raw == null) return createEmptyTree();
    if (isLegacyFormat(raw)) return migrateLegacyConnections(raw);
    if (!Array.isArray(raw.root)) return createEmptyTree();
    return { version: TREE_VERSION, root: raw.root };
  }

  function deserializeTree(jsonStr) {
    let parsed = null;
    if (jsonStr) {
      try { parsed = JSON.parse(jsonStr); } catch { parsed = null; }
    }
    return normalizeStoredData(parsed);
  }

  function serializeTree(tree) {
    return JSON.stringify(tree);
  }

  // Locates a node anywhere in the tree by id. Returns the live containing
  // array + index so callers holding a mutable clone can splice it, or null.
  function findNodeById(tree, id) {
    if (!tree || !Array.isArray(tree.root)) return null;
    const rootIndex = tree.root.findIndex(n => n.id === id);
    if (rootIndex !== -1) return { node: tree.root[rootIndex], container: tree.root, index: rootIndex, parentId: null };
    for (const node of tree.root) {
      if (node.type === 'folder') {
        const childIndex = node.children.findIndex(c => c.id === id);
        if (childIndex !== -1) {
          return { node: node.children[childIndex], container: node.children, index: childIndex, parentId: node.id };
        }
      }
    }
    return null;
  }

  function findConnectionByLabel(tree, label) {
    if (!tree || !Array.isArray(tree.root)) return null;
    for (const node of tree.root) {
      if (node.type === 'connection' && node.label === label) {
        return { node, container: tree.root, index: tree.root.indexOf(node), parentId: null };
      }
      if (node.type === 'folder') {
        const idx = node.children.findIndex(c => c.label === label);
        if (idx !== -1) return { node: node.children[idx], container: node.children, index: idx, parentId: node.id };
      }
    }
    return null;
  }

  function connectionLabelExists(tree, label, excludeId) {
    return !!findAnyConnection(tree, c => c.label === label && c.id !== excludeId);
  }

  function folderNameExists(tree, name, excludeId) {
    return tree.root.some(n => n.type === 'folder' && n.name === name && n.id !== excludeId);
  }

  function findAnyConnection(tree, predicate) {
    for (const node of tree.root) {
      if (node.type === 'connection' && predicate(node)) return node;
      if (node.type === 'folder') {
        const match = node.children.find(predicate);
        if (match) return match;
      }
    }
    return null;
  }

  function getAllConnectionLabels(tree) {
    const labels = [];
    for (const node of tree.root) {
      if (node.type === 'connection') labels.push(node.label);
      else if (node.type === 'folder') node.children.forEach(c => labels.push(c.label));
    }
    return labels;
  }

  // Creates a new connection (appended to root, or to folderId's children if
  // given) or updates the data of an existing connection with the same label
  // in place (preserving its id/position). Returns a new tree.
  function upsertConnection(tree, label, data, options = {}) {
    const clone = deepClone(tree);
    const existing = findConnectionByLabel(clone, label);
    if (existing) {
      existing.node.data = data;
      return clone;
    }
    const node = { type: 'connection', id: options.id || generateId('c'), label, data };
    if (options.folderId) {
      const folder = clone.root.find(n => n.type === 'folder' && n.id === options.folderId);
      if (folder) {
        folder.children.push(node);
        return clone;
      }
    }
    clone.root.push(node);
    return clone;
  }

  function removeConnectionByLabel(tree, label) {
    const found = findConnectionByLabel(tree, label);
    if (!found) return tree;
    return removeNodeById(tree, found.node.id);
  }

  function removeNodeById(tree, id) {
    const clone = deepClone(tree);
    const located = findNodeById(clone, id);
    if (!located) return tree;
    located.container.splice(located.index, 1);
    return clone;
  }

  function renameConnection(tree, id, newLabel) {
    const clone = deepClone(tree);
    const located = findNodeById(clone, id);
    if (!located || located.node.type !== 'connection') return tree;
    located.node.label = newLabel;
    return clone;
  }

  function createFolder(tree, name, id) {
    const clone = deepClone(tree);
    clone.root.push({ type: 'folder', id: id || generateId('f'), name, children: [] });
    return clone;
  }

  function renameFolder(tree, id, newName) {
    const clone = deepClone(tree);
    const folder = clone.root.find(n => n.type === 'folder' && n.id === id);
    if (!folder) return tree;
    folder.name = newName;
    return clone;
  }

  // mode: 'promote' (default) moves the folder's connections back to root in
  // the folder's former position; 'cascade' deletes the folder's connections
  // along with the folder.
  function deleteFolder(tree, id, mode = 'promote') {
    const clone = deepClone(tree);
    const idx = clone.root.findIndex(n => n.type === 'folder' && n.id === id);
    if (idx === -1) return tree;
    const folder = clone.root[idx];
    if (mode === 'cascade') {
      clone.root.splice(idx, 1);
    } else {
      clone.root.splice(idx, 1, ...folder.children);
    }
    return clone;
  }

  // Moves the node identified by `nodeId` so it lands at `targetIndex` within
  // `targetParentId`'s children (`null` = root). `targetIndex` is expressed
  // in terms of the target container's order *before* the move (i.e. the
  // position you'd compute from what's currently rendered) — this function
  // accounts for the index shift that happens when removing from/inserting
  // into the same array. Folders can only be moved within the root (they
  // cannot be nested); invalid moves are no-ops that return the original
  // tree unchanged.
  function moveNode(tree, nodeId, targetParentId, targetIndex) {
    const clone = deepClone(tree);
    const located = findNodeById(clone, nodeId);
    if (!located) return tree;
    const { node, container: sourceContainer, index: sourceIndex } = located;

    if (node.type === 'folder' && targetParentId !== null) return tree;

    let targetContainer;
    if (targetParentId === null) {
      targetContainer = clone.root;
    } else {
      const folder = clone.root.find(n => n.type === 'folder' && n.id === targetParentId);
      if (!folder) return tree;
      targetContainer = folder.children;
    }

    const sameContainer = sourceContainer === targetContainer;
    sourceContainer.splice(sourceIndex, 1);

    let insertIndex = targetIndex;
    if (sameContainer && sourceIndex < targetIndex) insertIndex -= 1;
    insertIndex = Math.max(0, Math.min(insertIndex, targetContainer.length));
    targetContainer.splice(insertIndex, 0, node);
    return clone;
  }

  // Merges `incomingTree` into `existingTree` (used by config import).
  // Incoming folders are always created as new folders (their connections
  // travel with them). Incoming connections whose label already exists
  // elsewhere in the tree are skipped unless `overwriteConflicts` is true,
  // in which case the existing connection's data is overwritten in place
  // (keeping its original id/position/folder).
  function mergeTrees(existingTree, incomingTree, overwriteConflicts) {
    let result = deepClone(existingTree);

    function mergeConnection(t, incomingNode, folderId) {
      const existing = findConnectionByLabel(t, incomingNode.label);
      if (existing) {
        if (!overwriteConflicts) return t;
        const clone = deepClone(t);
        const located = findNodeById(clone, existing.node.id);
        located.node.data = incomingNode.data;
        return clone;
      }
      return upsertConnection(t, incomingNode.label, incomingNode.data, { folderId });
    }

    for (const node of incomingTree.root) {
      if (node.type === 'connection') {
        result = mergeConnection(result, node, null);
      } else if (node.type === 'folder') {
        const newFolderId = generateId('f');
        result = createFolder(result, node.name, newFolderId);
        for (const child of node.children) {
          result = mergeConnection(result, child, newFolderId);
        }
      }
    }
    return result;
  }

  const api = {
    TREE_VERSION,
    generateId,
    createEmptyTree,
    isLegacyFormat,
    migrateLegacyConnections,
    normalizeStoredData,
    serializeTree,
    deserializeTree,
    findNodeById,
    findConnectionByLabel,
    connectionLabelExists,
    folderNameExists,
    getAllConnectionLabels,
    upsertConnection,
    removeConnectionByLabel,
    removeNodeById,
    renameConnection,
    createFolder,
    renameFolder,
    deleteFolder,
    moveNode,
    mergeTrees,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PulsarViewerConnectionsTree = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
