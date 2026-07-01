import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
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
  private suppress = false;

  constructor(parent: HTMLElement, onChange: () => void) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          oneDark,
          this.language.of([]),
          this.readOnlyC.of(EditorState.readOnly.of(true)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !this.suppress) onChange();
          }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace' },
          }),
        ],
      }),
    });
  }

  /** Replace the whole document + switch language, without firing onChange. */
  setContent(text: string, path: string): void {
    this.suppress = true;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      effects: this.language.reconfigure(langFor(path)),
    });
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
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: "" },
      effects: this.language.reconfigure([]),
    });
    this.suppress = false;
    this.setReadOnly(true);
  }

  focus(): void {
    this.view.focus();
  }
}
