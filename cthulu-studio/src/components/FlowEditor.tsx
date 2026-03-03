import { useRef, useImperativeHandle, forwardRef, useCallback, useEffect, useState } from "react";
import Editor, { type OnMount, type OnChange } from "@monaco-editor/react";
import yaml from "js-yaml";
import { registerFlowSchema } from "../lib/flow-schema";
import { applyMonacoTheme } from "../lib/monaco-theme";
import { useTheme } from "../lib/ThemeContext";

export interface FlowEditorHandle {
  revealNode: (nodeId: string) => void;
  /** Push text into the editor from an external source (preserves undo stack). */
  setText: (text: string) => void;
  /** Read the current editor text without triggering a render. */
  getText: () => string;
}

interface FlowEditorProps {
  defaultValue: string;
  onChange: (text: string) => void;
}

type EditorFormat = "json" | "yaml";

/** Convert JSON string → YAML string. Returns null on parse error. */
function jsonToYaml(jsonStr: string): string | null {
  try {
    const obj = JSON.parse(jsonStr);
    return yaml.dump(obj, { indent: 2, lineWidth: 120, noRefs: true });
  } catch {
    return null;
  }
}

/** Convert YAML string → JSON string. Returns null on parse error. */
function yamlToJson(yamlStr: string): string | null {
  try {
    const obj = yaml.load(yamlStr);
    return JSON.stringify(obj, null, 2);
  } catch {
    return null;
  }
}

const FlowEditor = forwardRef<FlowEditorHandle, FlowEditorProps>(
  function FlowEditor({ defaultValue, onChange }, ref) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editorRef = useRef<any>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monacoRef = useRef<any>(null);
    const { theme: appTheme } = useTheme();

    const [format, setFormat] = useState<EditorFormat>("json");
    // Suppress onChange callback when we're programmatically switching formats
    const suppressChangeRef = useRef(false);

    const handleMount: OnMount = useCallback((editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      registerFlowSchema(monaco);
      applyMonacoTheme(monaco, appTheme);
    }, [appTheme]);

    useEffect(() => {
      if (monacoRef.current) applyMonacoTheme(monacoRef.current, appTheme);
    }, [appTheme]);

    const handleChange: OnChange = useCallback(
      (val) => {
        if (suppressChangeRef.current) return;
        if (val === undefined) return;

        // Always emit JSON to the parent, regardless of display format
        if (format === "yaml") {
          const json = yamlToJson(val);
          if (json) onChange(json);
          // If YAML is invalid mid-edit, don't emit — wait for valid YAML
        } else {
          onChange(val);
        }
      },
      [onChange, format]
    );

    /** Switch between JSON and YAML in the editor */
    const switchFormat = useCallback((newFormat: EditorFormat) => {
      if (newFormat === format) return;
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const currentText = editor.getModel()?.getValue() ?? "";
      let converted: string | null = null;

      if (newFormat === "yaml") {
        converted = jsonToYaml(currentText);
      } else {
        converted = yamlToJson(currentText);
      }

      if (!converted) return; // Don't switch if conversion fails

      suppressChangeRef.current = true;
      const model = editor.getModel();
      if (model) {
        // Change language
        monaco.editor.setModelLanguage(model, newFormat === "yaml" ? "yaml" : "json");
        // Replace content
        editor.executeEdits("format-switch", [{
          range: model.getFullModelRange(),
          text: converted,
          forceMoveMarkers: false,
        }]);
      }
      suppressChangeRef.current = false;
      setFormat(newFormat);
    }, [format]);

    useImperativeHandle(ref, () => ({
      setText(text: string) {
        const editor = editorRef.current;
        if (!editor) return;
        const model = editor.getModel();
        if (!model) return;

        // If currently in YAML mode, convert incoming JSON to YAML
        let displayText = text;
        if (format === "yaml") {
          const yamlText = jsonToYaml(text);
          if (yamlText) displayText = yamlText;
        }

        // Only push if text actually differs — avoids cursor jump
        if (displayText === model.getValue()) return;
        suppressChangeRef.current = true;
        editor.executeEdits("external-update", [{
          range: model.getFullModelRange(),
          text: displayText,
          forceMoveMarkers: false,
        }]);
        suppressChangeRef.current = false;
      },

      getText() {
        const text = editorRef.current?.getModel()?.getValue() ?? "";
        // Always return JSON regardless of display format
        if (format === "yaml") {
          return yamlToJson(text) ?? text;
        }
        return text;
      },

      revealNode(nodeId: string) {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco) return;

        const model = editor.getModel();
        if (!model) return;

        const text = model.getValue();

        // Search for node ID in both JSON and YAML formats
        const jsonNeedle = `"id": "${nodeId}"`;
        const yamlNeedle = `id: ${nodeId}`;
        const needle = format === "yaml" ? yamlNeedle : jsonNeedle;
        const idx = text.indexOf(needle);
        if (idx === -1) return;

        if (format === "json") {
          // Walk backwards to find the opening { of this node object
          let braceCount = 0;
          let startIdx = idx;
          for (let i = idx; i >= 0; i--) {
            if (text[i] === "}") braceCount++;
            if (text[i] === "{") {
              if (braceCount === 0) {
                startIdx = i;
                break;
              }
              braceCount--;
            }
          }

          // Walk forwards to find the closing }
          braceCount = 0;
          let endIdx = idx;
          for (let i = startIdx; i < text.length; i++) {
            if (text[i] === "{") braceCount++;
            if (text[i] === "}") {
              braceCount--;
              if (braceCount === 0) {
                endIdx = i + 1;
                break;
              }
            }
          }

          const startPos = model.getPositionAt(startIdx);
          const endPos = model.getPositionAt(endIdx);

          editor.revealLineInCenter(startPos.lineNumber);
          editor.setSelection(
            new monaco.Range(
              startPos.lineNumber,
              startPos.column,
              endPos.lineNumber,
              endPos.column
            )
          );
        } else {
          // YAML: just reveal the line with the id
          const pos = model.getPositionAt(idx);
          editor.revealLineInCenter(pos.lineNumber);
          editor.setPosition(pos);
        }

        editor.focus();
      },
    }));

    return (
      <div className="flow-editor-container">
        <div className="flow-editor-toolbar">
          <button
            className={`flow-editor-format-btn${format === "json" ? " active" : ""}`}
            onClick={() => switchFormat("json")}
          >
            JSON
          </button>
          <button
            className={`flow-editor-format-btn${format === "yaml" ? " active" : ""}`}
            onClick={() => switchFormat("yaml")}
          >
            YAML
          </button>
        </div>
        <Editor
          language={format === "yaml" ? "yaml" : "json"}
          defaultValue={defaultValue}
          onChange={handleChange}
          onMount={handleMount}
          theme="cthulu-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            tabSize: 2,
            automaticLayout: true,
            folding: true,
            bracketPairColorization: { enabled: true },
            renderLineHighlight: "line",
            padding: { top: 8 },
          }}
        />
      </div>
    );
  }
);

export default FlowEditor;
