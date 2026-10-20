import { basicSetup, EditorView } from 'codemirror';
import { ChangeSet, Compartment, EditorState, MapMode, RangeSet, RangeValue, StateEffect, StateField, type Text } from '@codemirror/state';
import { gutter, GutterMarker } from '@codemirror/view';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';

/** What the blame gutter shows for one line; `key` groups consecutive lines of one commit. */
export interface BlameAnnotation {
  key: string;
  label: string;
  title: string;
  uncommitted: boolean;
}

/** A blame read of the editor's current text. `apply` places it even after later edits. */
export interface BlameRequest {
  text: string;
  apply(lines: readonly BlameAnnotation[], uncommitted: BlameAnnotation): void;
}

export interface ProjectCodeEditor {
  view: EditorView;
  language: string;
  getValue(): string;
  focus(): void;
  /** Starts a blame read; until it is applied or cleared, edits are remembered for it. */
  blame(): BlameRequest;
  clearBlame(): void;
  destroy(): void;
}

export interface ProjectDiffViewer {
  view: EditorView;
  language: string;
  destroy(): void;
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '0',
    color: 'var(--ink)',
    backgroundColor: 'transparent',
    fontSize: 'calc(12px * var(--text-scale, 1))'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    minHeight: '0',
    fontFamily: 'var(--mono)',
    lineHeight: '1.55',
    overflow: 'auto'
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '10px 0',
    caretColor: 'var(--ink)'
  },
  '.cm-line': { padding: '0 12px 0 8px' },
  '.cm-gutters': {
    backgroundColor: 'var(--sunk)',
    color: 'var(--faint)',
    border: '0',
    borderRight: '1px solid var(--line)'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '30px' },
  '.cm-blame-gutter': { borderRight: '1px solid var(--line)' },
  '.cm-blame-gutter .cm-gutterElement': {
    width: '150px',
    boxSizing: 'border-box',
    padding: '0 8px 0 10px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--ui-font, system-ui, sans-serif)',
    fontSize: 'calc(11px * var(--text-scale, 1))'
  },
  '.cm-blame.is-uncommitted': { color: 'var(--accent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--soft)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 62%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-wash)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--hover)',
    border: '1px solid var(--line)',
    color: 'var(--soft)'
  },
  '.cm-tooltip': {
    border: '1px solid var(--edge)',
    backgroundColor: 'var(--card)',
    color: 'var(--ink)'
  },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--ink)' },
  '.cm-searchMatch': { backgroundColor: 'var(--syntax-search)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--syntax-search-selected)' },
  '.cm-changedLine, .cm-inlineChangedLine': { backgroundColor: 'var(--green-wash)' },
  '.cm-changedText': { backgroundColor: 'color-mix(in srgb, var(--green) 24%, transparent)' },
  '.cm-deletedChunk': { backgroundColor: 'var(--red-wash)', color: 'var(--ink)' },
  '.cm-deletedText': { backgroundColor: 'color-mix(in srgb, var(--red) 24%, transparent)' },
  '.cm-changedLineGutter': { backgroundColor: 'var(--green)' },
  '.cm-deletedLineGutter': { backgroundColor: 'var(--red)' },
  '.cm-collapsedLines': { backgroundColor: 'var(--card)', color: 'var(--soft)', borderColor: 'var(--line)' }
});

const syntaxTheme = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.character, tags.docString, tags.attributeValue], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], color: 'var(--syntax-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--syntax-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--syntax-property)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--syntax-regexp)' },
  { tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator, tags.logicOperator, tags.compareOperator], color: 'var(--syntax-operator)' },
  { tag: [tags.labelName, tags.macroName], color: 'var(--syntax-label)' },
  { tag: tags.invalid, color: 'var(--red)', textDecoration: 'underline wavy' }
]);

class BlameGutterMarker extends GutterMarker {
  constructor(readonly annotation: BlameAnnotation, readonly first: boolean) { super(); }
  override eq(other: GutterMarker): boolean {
    return other instanceof BlameGutterMarker && other.annotation === this.annotation && other.first === this.first;
  }
  override toDOM(): Node {
    const node = document.createElement('span');
    node.className = this.annotation.uncommitted ? 'cm-blame is-uncommitted' : 'cm-blame';
    // Only the first line of a run of one commit is labelled; the rest keep the tooltip.
    if (this.first) node.textContent = this.annotation.label;
    node.title = this.annotation.title;
    return node;
  }
}

/** One line's annotation, anchored at the line start and moved with the text after it. */
class BlameMark extends RangeValue {
  readonly first: BlameGutterMarker;
  readonly rest: BlameGutterMarker;
  constructor(readonly annotation: BlameAnnotation) {
    super();
    this.first = new BlameGutterMarker(annotation, true);
    this.rest = new BlameGutterMarker(annotation, false);
  }
}
BlameMark.prototype.point = true;
BlameMark.prototype.startSide = BlameMark.prototype.endSide = 1;
BlameMark.prototype.mapMode = MapMode.TrackAfter;

interface BlameState { marks: RangeSet<BlameMark>; uncommitted: BlameMark; }

const setBlame = StateEffect.define<BlameState | null>();

/** Marks the lines `changes` rewrote as not committed; lines it only moved keep their commit. */
function markChanged(state: BlameState, changes: ChangeSet, before: Text, after: Text): BlameState {
  let marks = state.marks;
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    let first = after.lineAt(fromB).number, last = after.lineAt(toB).number;
    const startsWithBreak = inserted.lines > 1 && inserted.line(1).length === 0;
    const endsWithBreak = inserted.lines > 1 && inserted.line(inserted.lines).length === 0;
    if (!inserted.length && before.lineAt(fromA).from === fromA && before.lineAt(toA).from === toA) return;
    if (fromA === toA && startsWithBreak && before.lineAt(fromA).to === fromA) first++;
    if (endsWithBreak && before.lineAt(toA).from === toA) last--;
    if (first > last) return;
    const added = [];
    for (let number = first; number <= last; number++) added.push(state.uncommitted.range(after.line(number).from));
    marks = marks.update({ filter: () => false, filterFrom: after.line(first).from, filterTo: after.line(last).to, add: added });
  });
  return { marks, uncommitted: state.uncommitted };
}

const blameField = StateField.define<BlameState | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setBlame)) return effect.value;
    if (!value || !transaction.docChanged) return value;
    return markChanged({ marks: value.marks.map(transaction.changes), uncommitted: value.uncommitted },
      transaction.changes, transaction.startState.doc, transaction.newDoc);
  }
});

function markAt(marks: RangeSet<BlameMark>, position: number): BlameMark | null {
  let found = null as BlameMark | null;
  marks.between(position, position, (from, _to, value) => {
    if (from !== position) return;
    found = value;
    return false;
  });
  return found;
}

const blameGutter = gutter({
  class: 'cm-blame-gutter',
  lineMarker(view, line) {
    const value = view.state.field(blameField, false);
    const mark = value ? markAt(value.marks, line.from) : null;
    if (!value || !mark) return null;
    const previous = line.from > 0 ? markAt(value.marks, view.state.doc.lineAt(line.from - 1).from) : null;
    return previous?.annotation.key === mark.annotation.key ? mark.rest : mark.first;
  },
  lineMarkerChange: update => update.startState.field(blameField, false) !== update.state.field(blameField, false)
});

/**
 * Creates the shared code surface used by both the read-only preview and edit mode. Language
 * packages are loaded lazily from CodeMirror's catalogue so Files does not pay parser cost at
 * startup, while a clicked source file can still get highlighting as soon as its preview opens.
 */
export async function createProjectCodeEditor(options: {
  parent: HTMLElement;
  filename: string;
  text: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}): Promise<ProjectCodeEditor> {
  const description = LanguageDescription.matchFilename(languages, options.filename);
  let support = null;
  if (description) {
    try { support = await description.load(); }
    catch { /* An unavailable parser falls back to plain text without blocking editing. */ }
  }

  // The edits made while a blame read is out, so its answer can be mapped onto the newer text.
  let pendingBlame: { doc: Text; changes: ChangeSet } | null = null;
  const blameGutterSlot = new Compartment();
  const view = new EditorView({
    doc: options.text,
    parent: options.parent,
    extensions: [
      blameGutterSlot.of([]),
      basicSetup,
      editorTheme,
      syntaxHighlighting(syntaxTheme),
      EditorView.lineWrapping,
      EditorState.lineSeparator.of(options.text.includes('\r\n') ? '\r\n' : '\n'),
      EditorState.changeFilter.of(transaction => transaction.newDoc.length <= 256 * 1024),
      blameField,
      ...(support ? [support] : []),
      ...(options.readOnly ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        if (pendingBlame) pendingBlame.changes = pendingBlame.changes.compose(update.changes);
        options.onChange?.(update.state.sliceDoc());
      })
    ]
  });

  return {
    view,
    language: description?.name ?? 'Plain text',
    getValue: () => view.state.sliceDoc(),
    focus: () => view.focus(),
    blame: () => {
      const doc = view.state.doc;
      const request = { doc, changes: ChangeSet.empty(doc.length) };
      pendingBlame = request;
      return {
        text: view.state.sliceDoc(),
        apply: (lines, uncommitted) => {
          if (pendingBlame !== request) return;
          pendingBlame = null;
          const notCommitted = new BlameMark(uncommitted);
          const shared = new Map<BlameAnnotation, BlameMark>([[uncommitted, notCommitted]]);
          const marks = RangeSet.of(lines.slice(0, doc.lines).map((annotation, index) => {
            let mark = shared.get(annotation);
            if (!mark) shared.set(annotation, mark = new BlameMark(annotation));
            return mark.range(doc.line(index + 1).from);
          }));
          const value = markChanged({ marks: marks.map(request.changes), uncommitted: notCommitted }, request.changes, doc, view.state.doc);
          view.dispatch({ effects: [blameGutterSlot.reconfigure(blameGutter), setBlame.of(value)] });
        }
      };
    },
    clearBlame: () => {
      pendingBlame = null;
      view.dispatch({ effects: [blameGutterSlot.reconfigure([]), setBlame.of(null)] });
    },
    destroy: () => view.destroy()
  };
}

/** Read-only unified diff for either current Git state or one recorded edit. */
export async function createProjectDiffViewer(options: {
  parent: HTMLElement;
  filename: string;
  baseText: string;
  currentText: string;
}): Promise<ProjectDiffViewer> {
  const { getChunks, unifiedMergeView } = await import('@codemirror/merge');
  const description = LanguageDescription.matchFilename(languages, options.filename);
  let support = null;
  if (description) {
    try { support = await description.load(); }
    catch { /* Plain text remains a complete, readable fallback. */ }
  }
  const view = new EditorView({
    doc: options.currentText,
    parent: options.parent,
    extensions: [
      basicSetup,
      editorTheme,
      syntaxHighlighting(syntaxTheme),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      ...(support ? [support] : []),
      unifiedMergeView({
        original: options.baseText,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
        allowInlineDiffs: true,
        mergeControls: false,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 6 }
      })
    ]
  });
  const firstChange = getChunks(view.state)?.chunks[0];
  if (firstChange) {
    view.dispatch({ effects: EditorView.scrollIntoView(
      Math.min(firstChange.fromB, view.state.doc.length), { y: 'center' }
    ) });
  }
  return { view, language: description?.name ?? 'Plain text', destroy: () => view.destroy() };
}
