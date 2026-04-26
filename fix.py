import re
with open('packages/web/src/app/page.tsx', 'r') as f:
    c = f.read()

c = c.replace(
'''  metadata?: {
    memoriesRecalled?: number;
    memoriesExtracted?: number;
    profileUpdated?: boolean;
    ragSources?: string[];
  };''',
'''  metadata?: {
    memoriesRecalled?: number;
    memoriesExtracted?: number;
    profileUpdated?: boolean;
    ragSources?: string[];
  };
  audioUrl?: string;
  isAudioLoading?: boolean;'''
)

c = c.replace(
'''  const playTTS = async (text: string) => {
    try {
      const res = await fetch(`${API_URL}/api/voice/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (res.ok) {
        const audioBlob = await res.blob();
        const url = URL.createObjectURL(audioBlob);
        const audio = new Audio(url);
        audio.play();
      }
    } catch {
       // silent log or ignore
    }
  };''',
'''  const playTTS = async (text: string, msgId: string) => {
    const msg = messages.find(m => m.id === msgId);
    if (msg?.audioUrl) {
      new Audio(msg.audioUrl).play();
      return;
    }

    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, isAudioLoading: true } : m));
    try {
      const res = await fetch(`${API_URL}/api/voice/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (res.ok) {
        const audioBlob = await res.blob();
        const url = URL.createObjectURL(audioBlob);
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, audioUrl: url, isAudioLoading: false } : m));
        const audio = new Audio(url);
        audio.play();
      } else {
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, isAudioLoading: false } : m));
      }
    } catch {
       setMessages(prev => prev.map(m => m.id === msgId ? { ...m, isAudioLoading: false } : m));
    }
  };'''
)

c = c.replace('playTTS(data.response);', 'playTTS(data.response, assistantMsgId);')

c = c.replace(
'''  const loadSessionChat = async (id: string) => {''',
'''  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`${API_URL}/api/sessions/${id}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.id !== id));
      if (sessionId === id) {
        createNewChat();
      }
    } catch {
      /* silent */
    }
  };

  const loadSessionChat = async (id: string) => {'''
)

c = c.replace(
'''              <div className="session-list">
                {sessions.map(s => (
                  <button 
                    key={s.id} 
                    className={`session-item ${sessionId === s.id ? 'active' : ''}`}
                    onClick={() => loadSessionChat(s.id)}
                  >
                    💬 {s.title}
                  </button>
                ))}
              </div>''',
'''              <div className="session-list">
                {sessions.map(s => (
                  <div key={s.id} className={`session-item-container ${sessionId === s.id ? 'active' : ''}`} style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                    <button 
                      className={`session-item ${sessionId === s.id ? 'active' : ''}`}
                      onClick={() => loadSessionChat(s.id)}
                      style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '8px 12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      💬 {s.title}
                    </button>
                    <button onClick={(e) => deleteSession(s.id, e)} style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6, fontSize: '1rem', padding: '0 8px' }} title="Delete Chat">🗑️</button>
                  </div>
                ))}
              </div>'''
)

c = c.replace(
'''                    <button
                      className="message-action-btn"
                      onClick={() => playTTS(msg.content)}
                      title="Play Audio"
                    >
                      🔊
                    </button>''',
'''                    <button
                      className="message-action-btn"
                      onClick={() => playTTS(msg.content, msg.id)}
                      title="Play Audio"
                      disabled={msg.isAudioLoading}
                      style={{ opacity: msg.isAudioLoading ? 0.5 : 1 }}
                    >
                      {msg.isAudioLoading ? "⏳" : msg.audioUrl ? "▶️" : "🔊"}
                    </button>'''
)

with open('packages/web/src/app/page.tsx', 'w') as f:
    f.write(c)

