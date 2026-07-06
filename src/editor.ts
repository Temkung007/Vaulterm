import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { EditorState, Compartment, Prec, type Extension } from "@codemirror/state";
import { openSearchPanel, gotoLine } from "@codemirror/search";
import { StreamLanguage } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";

/** Pick a CodeMirror language extension from a remote file path. */
function langFor(path: string): Extension {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  if (name === "dockerfile") return StreamLanguage.define(dockerFile);
  if (name === "nginx.conf") return StreamLanguage.define(nginx);
  switch (ext) {
    case "json":
      return json();
    case "yml":
    case "yaml":
      return yaml();
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript();
    case "ts":
    case "tsx":
      return javascript({ typescript: true });
    case "py":
      return python();
    case "md":
    case "markdown":
      return markdown();
    case "css":
      return css();
    case "html":
    case "htm":
      return html();
    case "xml":
    case "svg":
      return xml();
    case "sql":
      return sql();
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define(shell);
    case "conf":
    case "cfg":
    case "ini":
    case "env":
    case "toml":
    case "properties":
      return StreamLanguage.define(properties);
    default:
      return [];
  }
}

/** A small wrapper around a CodeMirror 6 editor for the SFTP file editor. */
export class CodeEditor {
  private view: EditorView;
  private language = new Compartment();
  private readOnlyC = new Compartment();
  private wrapC = new Compartment();
  private suppress = false;
  /** Word-wrap is remembered across files (a per-editor preference). */
  private wrap = false;
  private onChange: () => void;
  private onSave?: () => void;

  constructor(parent: HTMLElement, onChange: () => void, onSave?: () => void) {
    this.onChange = onChange;
    this.onSave = onSave;
    this.view = new EditorView({ parent, state: this.makeState("", "", true) });
  }

  /**
   * Build a fresh EditorState. Loading a file swaps in a brand-new state (see
   * `setContent`) rather than editing the current doc, which gives every file
   * its own empty undo history — otherwise Ctrl+Z after opening file B could
   * resurrect (and then save) file A's content.
   */
  private makeState(doc: string, path: string, readOnly: boolean): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        // Runs before basicSetup's keymap and the webview's own Ctrl+S.
        Prec.highest(
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (this.onSave?.(), true) },
          ]),
        ),
        basicSetup,
        oneDark,
        this.language.of(langFor(path)),
        this.readOnlyC.of(EditorState.readOnly.of(readOnly)),
        this.wrapC.of(this.wrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !this.suppress) this.onChange();
        }),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace' },
        }),
      ],
    });
  }

  /** Load a file: replace the document + language with a fresh, editable state. */
  setContent(text: string, path: string): void {
    this.suppress = true;
    this.view.setState(this.makeState(text, path, false));
    this.suppress = false;
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  setReadOnly(ro: boolean): void {
    this.view.dispatch({ effects: this.readOnlyC.reconfigure(EditorState.readOnly.of(ro)) });
  }

  clear(): void {
    this.suppress = true;
    this.view.setState(this.makeState("", "", true));
    this.suppress = false;
  }

  /** Open CodeMirror's find/replace panel. */
  openFind(): void {
    openSearchPanel(this.view);
    this.view.focus();
  }

  /** Open the go-to-line prompt. */
  goToLine(): void {
    gotoLine(this.view);
  }

  /** Toggle soft word-wrap; returns the new state. Persists across files. */
  toggleWrap(): boolean {
    this.wrap = !this.wrap;
    this.view.dispatch({
      effects: this.wrapC.reconfigure(this.wrap ? EditorView.lineWrapping : []),
    });
    return this.wrap;
  }

  focus(): void {
    this.view.focus();
  }
}
