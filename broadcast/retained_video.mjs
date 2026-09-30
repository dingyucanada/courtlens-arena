// Patch the branch around a video without detaching it or its ancestors.
// Browsers can reset the media pipeline when a playing video leaves the DOM.
export function updateWorkspace(workspace, markup) {
  const template = document.createElement('template');
  template.innerHTML = markup;
  const current = workspace.querySelector('#broadcast-video');
  const next = template.content.querySelector('#broadcast-video');
  if (!current || !next || current.getAttribute('src') !== next.getAttribute('src')) {
    workspace.replaceChildren(template.content);
    return false;
  }
  function patchBranch(oldNode, newNode) {
    if (oldNode === current) return;
    if (oldNode.nodeType === 1 && newNode.nodeType === 1) {
      for (const attr of [...oldNode.attributes]) if (!newNode.hasAttribute(attr.name)) oldNode.removeAttribute(attr.name);
      for (const attr of [...newNode.attributes]) oldNode.setAttribute(attr.name,attr.value);
    }
    const oldBranch = [...oldNode.childNodes].find(node=>node===current || node.contains(current));
    const newBranch = [...newNode.childNodes].find(node=>node===next || node.contains(next));
    for (const child of [...oldNode.childNodes]) if (child!==oldBranch) child.remove();
    let before = true;
    for (const child of [...newNode.childNodes]) {
      if (child===newBranch) {before=false;continue;}
      if (before) oldNode.insertBefore(child,oldBranch); else oldNode.append(child);
    }
    patchBranch(oldBranch,newBranch);
  }
  patchBranch(workspace,template.content);
  return true;
}
