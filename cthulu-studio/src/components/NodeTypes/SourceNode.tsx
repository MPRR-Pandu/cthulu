import { Handle, Position } from "@xyflow/react";

interface SourceNodeData {
  label: string;
  kind: string;
  config: Record<string, unknown>;
  runStatus?: "running" | "completed" | "failed" | null;
  validationErrors?: string[];
}

export default function SourceNode({ data }: { data: SourceNodeData }) {
  return (
    <div className={`custom-node${data.runStatus ? ` run-${data.runStatus}` : ""}`}>
      <Handle id="in" type="target" position={Position.Left} />
      <div className="node-header">
        <span className="node-type-badge source">Source</span>
        {data.validationErrors && data.validationErrors.length > 0 && (
          <span className="node-validation-badge" title={data.validationErrors.join("\n")}>!</span>
        )}
      </div>
      <div className="node-label">{data.label}</div>
      <div className="node-kind">{data.kind}</div>
      <Handle id="out" type="source" position={Position.Right} />
    </div>
  );
}
