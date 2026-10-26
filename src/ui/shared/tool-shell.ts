/**
 * Shared shell behavior for collapsible sections and common UI affordances. It keeps repeated interaction patterns consistent across tool apps.
 */
const EXPAND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 10l5 5 5-5z"></path></svg>';
const COLLAPSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 14l5-5 5 5z"></path></svg>';

export interface ToolShellController {
  getExpanded: () => boolean;
  setExpanded: (nextExpanded: boolean) => void;
  toggle: () => void;
  dispose: () => void;
}

interface CreateToolShellControllerOptions {
  shell: HTMLElement | null;
  toggleButton: HTMLButtonElement | null;
  initialExpanded: boolean;
  onToggle?: (expanded: boolean) => void;
  onRender?: () => void;
}

interface CreateCompactRowShellControllerOptions {
  shell: HTMLElement | null;
  compactRow: HTMLElement | null;
  initialExpanded: boolean;
  onToggle?: (expanded: boolean) => void;
  onRender?: () => void;
}

function syncExpandButton(toggleButton: HTMLButtonElement | null, expanded: boolean): void {
  if (!toggleButton) {
    return;
  }
  const label = expanded ? 'Collapse' : 'Expand';
  toggleButton.title = label;
  toggleButton.setAttribute('aria-label', label);
  toggleButton.innerHTML = expanded ? COLLAPSE_ICON : EXPAND_ICON;
}

function syncShellClasses(shell: HTMLElement | null, expanded: boolean): void {
  if (!shell) {
    return;
  }
  shell.classList.toggle('expanded', expanded);
  shell.classList.toggle('collapsed', !expanded);
}

export function createToolShellController(options: CreateToolShellControllerOptions): ToolShellController {
  const { shell, toggleButton, initialExpanded, onToggle, onRender } = options;
  let isExpanded = initialExpanded;

  const applyExpandedState = (nextExpanded: boolean): void => {
    isExpanded = nextExpanded;
    syncShellClasses(shell, isExpanded);
    syncExpandButton(toggleButton, isExpanded);
  };

  const toggle = (): void => {
    applyExpandedState(!isExpanded);
    onToggle?.(isExpanded);
    onRender?.();
  };

  applyExpandedState(isExpanded);
  toggleButton?.addEventListener('click', toggle);

  return {
    getExpanded: () => isExpanded,
    setExpanded: applyExpandedState,
    toggle,
    dispose: () => {
      toggleButton?.removeEventListener('click', toggle);
    },
  };
}

export function createCompactRowShellController(options: CreateCompactRowShellControllerOptions): ToolShellController {
  const { shell, compactRow, initialExpanded, onToggle, onRender } = options;

  const controller = createToolShellController({
    shell,
    toggleButton: null,
    initialExpanded,
    onToggle: (expanded) => {
      compactRow?.setAttribute('aria-expanded', String(expanded));
      onToggle?.(expanded);
    },
    onRender,
  });

  compactRow?.setAttribute('aria-expanded', String(initialExpanded));

  const handleCompactClick = (): void => {
    controller.toggle();
  };

  const handleCompactKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    controller.toggle();
  };

  compactRow?.addEventListener('click', handleCompactClick);
  compactRow?.addEventListener('keydown', handleCompactKeydown);

  return {
    getExpanded: controller.getExpanded,
    setExpanded: controller.setExpanded,
    toggle: controller.toggle,
    dispose: () => {
      compactRow?.removeEventListener('click', handleCompactClick);
      compactRow?.removeEventListener('keydown', handleCompactKeydown);
      controller.dispose();
    },
  };
}
