// Sidecar panels render model-authored JSON that is persisted verbatim, so a
// shape the panel didn't anticipate is a matter of time. Without a boundary
// React unmounts the whole app on a render throw — one bad compliance block
// left a chat as a permanently blank page. This confines the failure to the
// panel that hit it (the answer text and every other panel still render) and
// reports it to Admin → Client errors with the chat and message ids.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../../lib/client-errors';

interface Props {
  name: string;
  chatId?: string;
  messageId?: string;
  children: ReactNode;
}

export class PanelBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`${this.props.name} panel failed to render`, error);
    reportClientError({
      kind: 'panel',
      source: this.props.name,
      error,
      componentStack: info.componentStack,
      chatId: this.props.chatId,
      messageId: this.props.messageId,
    });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className="text-xs text-ink/50 italic">
        The {this.props.name} section of this response could not be displayed.
      </p>
    );
  }
}
