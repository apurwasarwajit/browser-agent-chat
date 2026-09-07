import { useState, useRef, useEffect } from 'react';
import FindingAlert from './FindingAlert';
import PatternLearnedCard from './PatternLearnedCard';
import TaskCompletionCard from './TaskCompletionCard';
import type { ChatMessage, AgentStatus } from '../types';
import * as vaultApi from '../lib/vaultApi';
import { useAuth } from '../hooks/useAuth';
import { useWS } from '../contexts/WebSocketContext';

interface ChatPanelProps {
  agentId: string;
  messages: ChatMessage[];
  status: AgentStatus;
  currentUrl: string | null;
  showExplore: boolean;
  lastCompletedTask: { taskId: string; success: boolean; stepCount: number; durationMs: number } | null;
  onExplore: () => void;
  onSendTask: (content: string) => void;
  onFeedback: (taskId: string, rating: 'positive' | 'negative', correction?: string) => void;
}

export default function ChatPanel({
  agentId: _agentId, messages, status, currentUrl,
  showExplore, lastCompletedTask, onExplore,
  onSendTask, onFeedback,
}: ChatPanelProps) {
  const { getAccessToken } = useAuth();
  const {
    pendingCredentialRequest,
    sendCredentialProvided,
    pendingActionConfirmation,
    sendActionConfirmation,
    feedbackAck,
    sessionWarning,
    sessionEvicted,
    sendRestart,
    startAgent,
  } = useWS();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputDisabled = status === 'crashed' || status === 'error';

  const prevStatus = useRef<AgentStatus>(status);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [credUsername, setCredUsername] = useState('');
  const [credPassword, setCredPassword] = useState('');
  const [credLabel, setCredLabel] = useState('');
  const [credSaving, setCredSaving] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);

  const handleCredentialSubmit = async () => {
    setCredSaving(true);
    setCredError(null);
    try {
      const token = await getAccessToken();
      const result = await vaultApi.createCredential(token, {
        label: credLabel || pendingCredentialRequest!.domain,
        credential_type: 'username_password',
        secret: { password: credPassword },
        metadata: { username: credUsername },
        domains: [pendingCredentialRequest!.domain],
      });
      if (result) {
        await vaultApi.bindToAgent(token, result.id, pendingCredentialRequest!.agentId);
        sendCredentialProvided(result.id);
        setCredUsername('');
        setCredPassword('');
        setCredLabel('');
      } else {
        setCredError('Failed to save credential. Please try again.');
      }
    } catch (err) {
      setCredError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setCredSaving(false);
    }
  };

  const handleCredentialSkip = () => {
    sendCredentialProvided('');
    setCredUsername('');
    setCredPassword('');
    setCredLabel('');
    setCredError(null);
  };

  useEffect(() => {
    if (prevStatus.current === 'working' && status === 'idle') {
      setShowSuggestions(true);
    }
    if (status === 'working') {
      setShowSuggestions(false);
    }
    prevStatus.current = status;
  }, [status]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || inputDisabled) return;
    onSendTask(input.trim());
    setInput('');
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-status">
          <span className={`status-dot status-${status}`} />
          <span className="status-text">{status}</span>
        </div>
        {status === 'disconnected' && !sessionEvicted && (
          <span className="chat-status-indicator reconnecting">Reconnecting...</span>
        )}
        {sessionEvicted && (
          <button className="btn-primary btn-sm" onClick={() => startAgent(_agentId)}>Reconnect</button>
        )}
        {(status === 'crashed' || status === 'error') && (
          <button className="btn-primary btn-sm" onClick={() => sendRestart(_agentId)}>Restart</button>
        )}
      </div>

      {currentUrl && <div className="chat-url">{currentUrl}</div>}

      <div className="chat-messages">
        {messages.map(msg => (
          <div key={msg.id} className={`chat-message chat-message-${msg.type}`}>
            {msg.type === 'finding' && msg.finding ? (
              <FindingAlert finding={msg.finding} />
            ) : msg.patternData ? (
              <PatternLearnedCard
                name={msg.patternData.name}
                steps={msg.patternData.steps}
                successRate={msg.patternData.successRate}
                runs={msg.patternData.runs}
                transition={msg.patternData.transition}
                isCelebration={msg.patternData.isCelebration}
              />
            ) : (
              <p>{msg.content}</p>
            )}
          </div>
        ))}
        {lastCompletedTask && (
          <TaskCompletionCard
            taskId={lastCompletedTask.taskId}
            success={lastCompletedTask.success}
            stepCount={lastCompletedTask.stepCount}
            durationMs={lastCompletedTask.durationMs}
            onFeedback={onFeedback}
            feedbackAck={feedbackAck}
          />
        )}
        <div ref={messagesEndRef} />
      </div>

      {(showSuggestions || showExplore) && status === 'idle' && (
        <div className="chat-suggestions">
          {showExplore && (
            <button className="chat-suggestion-chip" onClick={() => { onExplore(); setShowSuggestions(false); }}>
              Explore this app
            </button>
          )}
          <button className="chat-suggestion-chip" onClick={() => { onSendTask('Test the login flow'); setShowSuggestions(false); }}>
            Test login flow
          </button>
          <button className="chat-suggestion-chip" onClick={() => { onSendTask('Check all links on this page'); setShowSuggestions(false); }}>
            Check all links
          </button>
          <button className="chat-suggestion-chip" onClick={() => { onSendTask('Test form validation'); setShowSuggestions(false); }}>
            Test form validation
          </button>
        </div>
      )}

      {pendingCredentialRequest && (
        <div className="chat-cred-form">
          <div className="chat-cred-form-title">
            Credentials needed for <strong>{pendingCredentialRequest.domain}</strong>
          </div>
          <input type="text" placeholder="Label (optional)" value={credLabel} onChange={e => setCredLabel(e.target.value)} />
          <input type="text" placeholder="Username" value={credUsername} onChange={e => setCredUsername(e.target.value)} autoComplete="off" />
          <input type="password" placeholder="Password" value={credPassword} onChange={e => setCredPassword(e.target.value)} autoComplete="new-password" />
          {credError && <div className="chat-cred-form-error">{credError}</div>}
          <div className="chat-cred-form-actions">
            <button
              className="chat-cred-form-save"
              onClick={handleCredentialSubmit}
              disabled={credSaving || !credUsername.trim() || !credPassword.trim()}
            >
              {credSaving ? 'Saving...' : 'Save & Login'}
            </button>
            <button className="chat-cred-form-skip" onClick={handleCredentialSkip} disabled={credSaving}>
              Skip
            </button>
          </div>
        </div>
      )}

      {pendingActionConfirmation && (
        <div className="chat-cred-form">
          <div className="chat-cred-form-title">Action confirmation required</div>
          <div>
            The agent wants to perform <strong>{pendingActionConfirmation.action}</strong> on{' '}
            <strong>{pendingActionConfirmation.target}</strong> at {pendingActionConfirmation.origin} because{' '}
            {pendingActionConfirmation.reason}. The target label is untrusted page content.
          </div>
          <div className="chat-cred-form-actions">
            <button
              className="chat-cred-form-save"
              onClick={() => sendActionConfirmation(pendingActionConfirmation.confirmationId, true)}
            >
              Allow once
            </button>
            <button
              className="chat-cred-form-skip"
              onClick={() => sendActionConfirmation(pendingActionConfirmation.confirmationId, false)}
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {sessionWarning && (
        <div className="chat-status-banner warning">{sessionWarning}</div>
      )}

      <form className="chat-input" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={inputDisabled ? 'Session error — restart to continue' : status === 'working' ? 'Type a message (will send when ready)...' : 'Send a message...'}
          disabled={inputDisabled}
        />
        <button type="submit" disabled={!input.trim() || inputDisabled}>→</button>
      </form>
    </div>
  );
}
