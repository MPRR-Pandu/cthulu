import { Handle, Position } from "@xyflow/react";

interface TriggerNodeData {
  label: string;
  kind: string;
  config: Record<string, unknown>;
  runStatus?: "running" | "completed" | "failed" | null;
  validationErrors?: string[];
}

export default function TriggerNode({ data }: { data: TriggerNodeData }) {
  return (
    <div className={`custom-node${data.runStatus ? ` run-${data.runStatus}` : ""}`}>
      <div className="node-header">
        <span className="node-type-badge trigger">Trigger</span>
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
