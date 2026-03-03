import { useAgentChat } from "./chat/useAgentChat";
import AgentChatThread from "./chat/AgentChatThread";

interface AgentChatViewProps {
  agentId: string;
  sessionId: string;
  busy?: boolean;
  onAssistantComplete?: (fullText: string) => void;
}

export default function AgentChatView({ agentId, sessionId, onAssistantComplete }: AgentChatViewProps) {
  const chat = useAgentChat(agentId, sessionId, { onAssistantComplete });

  return (
    <AgentChatThread
      messages={chat.messages}
      isStreaming={chat.isStreaming}
      resultMeta={chat.resultMeta}
      isDone={chat.isDone}
      onNew={chat.handleSend}
      onCancel={chat.handleCancel}
      attachments={chat.attachments}
      onAddFiles={chat.addFiles}
      onRemoveAttachment={chat.removeAttachment}
      fileInputRef={chat.fileInputRef}
      debugMode={chat.debugMode}
      debugEvents={chat.debugEvents}
      onToggleDebug={() => chat.setDebugMode((v) => !v)}
      onClearDebug={chat.clearDebugEvents}
      onClear={chat.clearMessages}
      onInjectAssistant={chat.injectAssistantMessage}
      gitSnapshot={chat.gitSnapshot}
    />
  );
}
