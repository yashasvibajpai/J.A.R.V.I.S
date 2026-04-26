"use client";

import { useState, useRef, useEffect, useCallback, type FormEvent } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  feedback?: "up" | "down";
  metadata?: {
    memoriesRecalled?: number;
    memoriesExtracted?: number;
    profileUpdated?: boolean;
    ragSources?: string[];
  };
  audioUrl?: string;
  isAudioLoading?: boolean;
}

interface Memory {
  id: string;
  content: string;
  category: string;
  createdAt: string;
}

interface Task {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'low' | 'medium' | 'high';
  dueDate?: string;
  tags: string[];
}

interface Reminder {
  id: string;
  description: string;
  triggerTime?: string;
  triggerContext?: string;
  completed: boolean;
}

interface UserProfile {
  name: string;
  preferredName?: string;
  preferences: Record<string, string>;
  context: Record<string, unknown>;
  version: number;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<{ id: string; title: string }[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<"chat" | "profile" | "memory" | "tasks">("chat");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [memoryCount, setMemoryCount] = useState(0);

  // Voice Mode State
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
  };

  // ─── Voice Interaction ──────────────────────────────────────────────────

  const toggleRecording = async () => {
    if (isRecording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
           audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
         const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
         const formData = new FormData();
         formData.append('file', audioBlob, 'recording.webm');
         
         setIsLoading(true);
         try {
           const res = await fetch(`${API_URL}/api/voice/transcribe`, {
             method: 'POST',
             body: formData
           });
           const data = await res.json();
           if (data.text !== undefined) {
             if (data.text.trim()) {
               sendMessage(data.text);
             } else {
               setIsLoading(false); // Graceful exit on silent/empty transcription
             }
           } else {
             console.error("Transcription API Error:", data.error || data);
             setIsLoading(false);
           }
         } catch {
           console.error("Failed to transcribe audio.");
           setIsLoading(false);
         } finally {
           stream.getTracks().forEach(track => track.stop());
         }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err: any) {
       console.error("Microphone access denied or unavailable.", err);
       alert("Microphone access blocked. Ensure you are on localhost or HTTPS, and have granted microphone permissions to your browser.");
    }
  };

  const playTTS = async (text: string, msgId: string) => {
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
        audio.play().catch(e => console.error("Playback failed: ", e));
      } else {
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, isAudioLoading: false } : m));
      }
    } catch {
       console.error("Failed to synthesize TTS.");
       setMessages(prev => prev.map(m => m.id === msgId ? { ...m, isAudioLoading: false } : m));
    }
  };

  // ─── Load Profile, Memories & Sessions ────────────────────────────────────────────────

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/sessions`);
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      /* silent */
    }
  }, []);

  // ─── Send Message ───────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (e?: FormEvent | string) => {
      if (typeof e !== 'string') {
        e?.preventDefault();
      }
      const text = typeof e === 'string' ? e.trim() : input.trim();
      if (!text || isLoading) return;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setIsLoading(true);

      // Reset textarea height
      if (inputRef.current) inputRef.current.style.height = "auto";

      try {
        const res = await fetch(`${API_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, sessionId: sessionId || undefined }),
        });

        if (!res.ok) throw new Error(`API error: ${res.status}`);

        const data = await res.json();

        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.response || "No response received.",
          timestamp: new Date().toISOString(),
          metadata: data.metadata,
        };

        setMessages((prev) => [...prev, assistantMsg]);

        if (data.sessionId && !sessionId) {
          setSessionId(data.sessionId);
          loadSessions(); // refresh the sidebar sessions list
        }

        // Update memory count after extraction
        if (data.metadata?.memoriesExtracted > 0) {
          setMemoryCount((c) => c + data.metadata.memoriesExtracted);
        }

        // Live Voice Mode Auto-Playback
        if (data.response) { 
          playTTS(data.response, assistantMsgId); 
        }
      } catch (err) {
        const errorMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Connection error — is the JARVIS API running on ${API_URL}?`,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      } finally {
        setIsLoading(false);
        inputRef.current?.focus();
      }
    },
    [input, isLoading, sessionId, loadSessions]
  );

  // ─── Keyboard Handling ──────────────────────────────────────────────────

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ─── Feedback ───────────────────────────────────────────────────────────

  const handleFeedback = (msgId: string, type: "up" | "down") => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? { ...m, feedback: m.feedback === type ? undefined : type }
          : m
      )
    );
  };

  const deleteMemory = async (id: string) => {
    try {
      await fetch(`${API_URL}/api/memories/${id}`, { method: 'DELETE' });
      loadMemories(); // Refresh the list
    } catch {
      console.error("Failed to delete memory");
    }
  };

  const updateTask = async (id: string, updates: Partial<Task>) => {
    try {
      await fetch(`${API_URL}/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      loadTasksAndReminders();
    } catch { console.error("Failed to update task"); }
  };

  const deleteTask = async (id: string) => {
    try {
      await fetch(`${API_URL}/api/tasks/${id}`, { method: 'DELETE' });
      loadTasksAndReminders();
    } catch { console.error("Failed to delete task"); }
  };

  const updateReminder = async (id: string, updates: Partial<Reminder>) => {
    try {
      await fetch(`${API_URL}/api/reminders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      loadTasksAndReminders();
    } catch { console.error("Failed to update reminder"); }
  };

  const deleteReminder = async (id: string) => {
    try {
      await fetch(`${API_URL}/api/reminders/${id}`, { method: 'DELETE' });
      loadTasksAndReminders();
    } catch { console.error("Failed to delete reminder"); }
  };

  // ─── Load Profile, Memories & Sessions ────────────────────────────────────────────────


  const deleteSession = async (id: string, e: React.MouseEvent) => {
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

  const loadSessionChat = async (id: string) => {
    try {
      const res = await fetch(`${API_URL}/api/sessions/${id}/messages`);
      const data = await res.json();
      const loadedMessages = data.messages.map((m: any) => ({
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content,
        timestamp: new Date().toISOString()
      }));
      setMessages(loadedMessages);
      setSessionId(id);
      setActivePanel("chat");
      if (window.innerWidth <= 768) setSidebarOpen(false);
    } catch {
      /* silent */
    }
  };

  const createNewChat = () => {
    setMessages([]);
    setSessionId(null);
    setActivePanel("chat");
    if (window.innerWidth <= 768) setSidebarOpen(false);
  };

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/profile`);
      const data = await res.json();
      setProfile(data.profile);
    } catch {
      /* silent */
    }
  }, []);

  const updateProfile = async (updates: Partial<UserProfile>) => {
    try {
      const res = await fetch(`${API_URL}/api/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const data = await res.json();
      setProfile(data.profile);
    } catch { console.error("Failed to update profile"); }
  };

  const loadMemories = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/memories`);
      const data = await res.json();
      setMemories(data.memories || []);
      setMemoryCount(data.count || 0);
    } catch {
      /* silent */
    }
  }, []);

  const loadTasksAndReminders = useCallback(async () => {
    try {
      const [taskRes, remRes] = await Promise.all([
        fetch(`${API_URL}/api/tasks`),
        fetch(`${API_URL}/api/reminders`)
      ]);
      const [taskData, remData] = await Promise.all([taskRes.json(), remRes.json()]);
      setTasks(taskData.tasks || []);
      setReminders(remData.reminders || []);
    } catch {
      /* silent */
    }
  }, []);

  // Load on panel switch
  useEffect(() => {
    if (activePanel === "profile") loadProfile();
    if (activePanel === "memory") loadMemories();
    if (activePanel === "tasks") loadTasksAndReminders();
  }, [activePanel, loadProfile, loadMemories, loadTasksAndReminders]);

  // Initial load for memory count & sessions
  useEffect(() => {
    loadSessions();
    fetch(`${API_URL}/health`)
      .then((r) => r.json())
      .then((d) => setMemoryCount(d.memory?.count || 0))
      .catch(() => { });
  }, [loadSessions]);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="app-layout">
      {/* Mobile sidebar toggle */}
      <button
        className="sidebar-toggle"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="Toggle sidebar"
      >
        ☰
      </button>

      {/* Backdrop */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop visible"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <div className="sidebar-title" style={{ fontSize: '1.5rem', letterSpacing: '2px', width: '100%', textAlign: 'center' }}>J.A.R.V.I.S</div>
        </div>

        <nav className="sidebar-nav">
          <button
            className={`sidebar-nav-item ${activePanel === "chat" ? "active" : ""}`}
            onClick={() => { setActivePanel("chat"); setSidebarOpen(false); }}
          >
            💬 Chat
          </button>
          <button
            className={`sidebar-nav-item ${activePanel === "profile" ? "active" : ""}`}
            onClick={() => { setActivePanel("profile"); setSidebarOpen(false); }}
          >
            👤 Profile
          </button>
          <button
            className={`sidebar-nav-item ${activePanel === "tasks" ? "active" : ""}`}
            onClick={() => { setActivePanel("tasks"); setSidebarOpen(false); }}
          >
            ☑️ Tasks
          </button>
          <button
            className={`sidebar-nav-item ${activePanel === "memory" ? "active" : ""}`}
            onClick={() => { setActivePanel("memory"); setSidebarOpen(false); }}
          >
            🧠 Memories
          </button>
        </nav>

        {/* Sidebar panel content */}
        <div className="sidebar-content">
          {activePanel === "profile" && (
            <ProfilePanel profile={profile} onUpdateProfile={updateProfile} />
          )}
          {activePanel === "memory" && (
            <MemoryPanel memories={memories} onDelete={deleteMemory} />
          )}
          {activePanel === "tasks" && (
            <TaskPanel 
              tasks={tasks} 
              reminders={reminders} 
              onUpdateTask={updateTask}
              onDeleteTask={deleteTask}
              onUpdateReminder={updateReminder}
              onDeleteReminder={deleteReminder}
            />
          )}
          {activePanel === "chat" && (
            <div className="chat-history-sidebar">
              <button className="new-chat-btn" onClick={createNewChat}>
                + New Chat
              </button>
              
              <div className="session-list">
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
              </div>

              <div className="stat-grid" style={{ marginTop: 'auto', paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <div className="stat-item">
                  <div className="stat-value">{memoryCount}</div>
                  <div className="stat-label">Memories</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{messages.length}</div>
                  <div className="stat-label">Messages</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="main-content">
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="arc-reactor">
              <div className="arc-ring arc-outer"></div>
              <div className="arc-ring arc-middle dashed"></div>
              <div className="arc-ring arc-inner"></div>
              <div className="arc-core">
              </div>
            </div>
            <h1>J.A.R.V.I.S</h1>
            <p>
              Good {getTimeOfDay()}. How may I be of assistance?
            </p>
          </div>
        ) : (
          <div className="chat-messages">
            {messages.map((msg) => (
              <div key={msg.id} className="message">
                <div className="message-header">
                  <div className={`message-avatar ${msg.role}`}>
                    {msg.role === "assistant" ? "J" : "Y"}
                  </div>
                  <span className={`message-name ${msg.role}`}>
                    {msg.role === "assistant" ? "JARVIS" : "You"}
                  </span>
                </div>
                <div className="message-body">
                  {msg.content.split("\n").map((line, i) => (
                    <p key={i}>{line || "\u00A0"}</p>
                  ))}
                  {/* RAG Citations */}
                  {msg.role === 'assistant' && msg.metadata?.ragSources && msg.metadata.ragSources.length > 0 && (
                      <div className="rag-citations" style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {msg.metadata.ragSources.map((source, i) => (
                          <span key={i} style={{ fontSize: '0.75rem', background: 'rgba(14, 165, 233, 0.1)', color: 'var(--accent)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--accent)' }}>
                            📄 {source}
                          </span>
                        ))}
                      </div>
                  )}
                </div>
                {msg.role === "assistant" && (
                  <div className="message-actions">
                    <button
                      className="message-action-btn"
                      onClick={() => playTTS(msg.content, msg.id)}
                      title="Play Audio"
                      disabled={msg.isAudioLoading}
                      style={{ opacity: msg.isAudioLoading ? 0.5 : 1 }}
                    >
                      {msg.isAudioLoading ? "⏳" : msg.audioUrl ? "▶️" : "🔊"}
                    </button>
                    <button
                      className={`message-action-btn ${msg.feedback === "up" ? "active" : ""}`}
                      onClick={() => handleFeedback(msg.id, "up")}
                      title="Good response"
                    >
                      👍
                    </button>
                    <button
                      className={`message-action-btn ${msg.feedback === "down" ? "active" : ""}`}
                      onClick={() => handleFeedback(msg.id, "down")}
                      title="Could be better"
                    >
                      👎
                    </button>
                    {msg.metadata?.memoriesExtracted ? (
                      <span className="message-action-btn" title="Memories extracted">
                        🧠 {msg.metadata.memoriesExtracted}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            ))}

            {isLoading && (
              <div className="message">
                <div className="message-header">
                  <div className="message-avatar assistant">J</div>
                  <span className="message-name assistant">JARVIS</span>
                </div>
                <div className="typing-indicator">
                  <div className="typing-dot" />
                  <div className="typing-dot" />
                  <div className="typing-dot" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Input */}
        <div className="input-area">
          <form className="input-container" onSubmit={sendMessage}>
            <textarea
              ref={inputRef}
              className="input-field"
              placeholder="Message JARVIS..."
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isLoading}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className={`send-btn ${isRecording ? 'recording' : ''}`}
                onClick={toggleRecording}
                title={isRecording ? "Stop recording" : "Record voice"}
                style={{ background: isRecording ? '#ef4444' : undefined }}
              >
                🎙️
              </button>
              <button
              type="submit"
              className="send-btn"
              disabled={!input.trim() || isLoading}
              title="Send message"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

// ─── Sub-Components ─────────────────────────────────────────────────────────

function ProfilePanel({ 
  profile, 
  onUpdateProfile 
}: { 
  profile: UserProfile | null,
  onUpdateProfile: (updates: Partial<UserProfile>) => void
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editLocation, setEditLocation] = useState("");

  useEffect(() => {
    if (profile) {
      setEditName(profile.preferredName || profile.name);
      setEditRole(profile.context?.role || "");
      setEditLocation(profile.context?.location || "");
    }
  }, [profile, isEditing]);

  if (!profile) {
    return <div className="empty-state">Loading profile...</div>;
  }

  const handleSave = () => {
    onUpdateProfile({
      preferredName: editName,
      context: {
        ...profile.context,
        role: editRole,
        location: editLocation
      }
    });
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div className="sidebar-section-title">Edit Profile</div>
        <div className="panel-card">
          <div className="panel-card-title">Identity</div>
          <input className="input-field" value={editName} onChange={e => setEditName(e.target.value)} style={{ background: 'transparent', color: 'white', padding: '4px', marginTop: '4px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', width: '100%' }} />
        </div>
        <div className="panel-card">
          <div className="panel-card-title">Role</div>
          <input className="input-field" value={editRole} onChange={e => setEditRole(e.target.value)} style={{ background: 'transparent', color: 'white', padding: '4px', marginTop: '4px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', width: '100%' }} />
        </div>
        <div className="panel-card">
          <div className="panel-card-title">Location</div>
          <input className="input-field" value={editLocation} onChange={e => setEditLocation(e.target.value)} style={{ background: 'transparent', color: 'white', padding: '4px', marginTop: '4px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', width: '100%' }} />
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button className="new-chat-btn" onClick={handleSave} style={{ flex: 1, textAlign: 'center', background: 'rgba(14, 165, 233, 0.2)' }}>Save</button>
          <button className="new-chat-btn" onClick={() => setIsEditing(false)} style={{ flex: 1, textAlign: 'center' }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sidebar-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        User Profile (v{profile.version})
        <button onClick={() => setIsEditing(true)} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' }}>Edit</button>
      </div>

      <div className="panel-card">
        <div className="panel-card-title">👤 Identity</div>
        <div className="panel-card-value">
          {profile.preferredName || profile.name}
        </div>
      </div>

      {profile.context?.role && (
        <div className="panel-card">
          <div className="panel-card-title">💼 Role</div>
          <div className="panel-card-value">{String(profile.context.role)}</div>
        </div>
      )}

      {profile.context?.location && (
        <div className="panel-card">
          <div className="panel-card-title">📍 Location</div>
          <div className="panel-card-value">{String(profile.context.location)}</div>
        </div>
      )}

      {Array.isArray(profile.context?.goals) && profile.context.goals.length > 0 && (
        <div className="panel-card">
          <div className="panel-card-title">🎯 Goals</div>
          <div className="panel-card-value">
            {(profile.context.goals as string[]).map((g, i) => (
              <div key={i}>• {g}</div>
            ))}
          </div>
        </div>
      )}

      {Object.keys(profile.preferences).length > 0 && (
        <div className="panel-card">
          <div className="panel-card-title">⚙️ Preferences</div>
          <div className="panel-card-value">
            {Object.entries(profile.preferences).map(([k, v]) => (
              <div key={k}>
                <strong>{k}:</strong> {v}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function MemoryPanel({ memories, onDelete }: { memories: Memory[], onDelete: (id: string) => void }) {
  if (memories.length === 0) {
    return (
      <div className="empty-state">
        No memories yet. Start chatting and JARVIS will begin remembering.
      </div>
    );
  }

  return (
    <>
      <div className="sidebar-section-title">
        Memories ({memories.length})
      </div>
      {memories.map((m) => (
        <div key={m.id} className="memory-item" style={{ position: 'relative' }}>
          <div className="memory-category">{m.category}</div>
          <div className="memory-content">{m.content}</div>
          <div className="memory-date" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {new Date(m.createdAt).toLocaleDateString()}
            <button 
                onClick={() => onDelete(m.id)} 
                title="Delete memory"
                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.8rem' }}
            >
              🗑️
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function TaskPanel({ 
  tasks, 
  reminders, 
  onUpdateTask, 
  onDeleteTask, 
  onUpdateReminder, 
  onDeleteReminder 
}: { 
  tasks: Task[], 
  reminders: Reminder[], 
  onUpdateTask: (id: string, updates: Partial<Task>) => void,
  onDeleteTask: (id: string) => void,
  onUpdateReminder: (id: string, updates: Partial<Reminder>) => void,
  onDeleteReminder: (id: string) => void
}) {
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  
  return (
    <>
      <div className="sidebar-section-title">
        Open Tasks ({pendingTasks.length})
      </div>
      {pendingTasks.length === 0 ? (
         <div className="empty-state">No open tasks. You&apos;re all caught up!</div>
      ) : (
         pendingTasks.map((t) => (
           <div key={t.id} className="memory-item" style={{ position: 'relative' }}>
             <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
               <input 
                 type="checkbox" 
                 onChange={(e) => onUpdateTask(t.id, { status: e.target.checked ? 'completed' : 'pending' })} 
                 style={{ marginTop: '4px', cursor: 'pointer' }}
               />
               <div style={{ flex: 1 }}>
                 <div className="memory-category" style={{color: 'var(--accent)'}}>{t.priority} priority</div>
                 <div className="memory-content" style={{fontSize: '15px'}}>{t.description}</div>
                 {t.dueDate && <div className="memory-date">Due: {t.dueDate}</div>}
               </div>
               <button 
                 onClick={() => onDeleteTask(t.id)} 
                 title="Delete task"
                 style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.8rem' }}
               >
                 🗑️
               </button>
             </div>
           </div>
         ))
      )}

      <div className="sidebar-section-title" style={{ marginTop: '24px' }}>
        Active Reminders ({reminders.length})
      </div>
      {reminders.length === 0 ? (
         <div className="empty-state">No active reminders.</div>
      ) : (
         reminders.map((r) => (
           <div key={r.id} className="memory-item">
             <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                <input 
                  type="checkbox" 
                  onChange={(e) => onUpdateReminder(r.id, { completed: e.target.checked })} 
                  style={{ marginTop: '4px', cursor: 'pointer' }}
                />
                <div style={{ flex: 1 }}>
                  <div className="memory-content">⏰ {r.description}</div>
                  {(r.triggerTime || r.triggerContext) && (
                      <div className="memory-date">Trigger: {r.triggerTime || r.triggerContext}</div>
                  )}
                </div>
                <button 
                  onClick={() => onDeleteReminder(r.id)} 
                  title="Delete reminder"
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  🗑️
                </button>
             </div>
           </div>
         ))
      )}
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTimeOfDay(): string {
  // Convert current time to IST explicitly
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  });
  const hour = parseInt(formatter.format(new Date()), 10);
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}
