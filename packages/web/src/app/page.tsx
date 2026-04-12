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
  };
}

interface Memory {
  id: string;
  content: string;
  category: string;
  createdAt: string;
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
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<"chat" | "profile" | "memory">("chat");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [memoryCount, setMemoryCount] = useState(0);

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

  // ─── Send Message ───────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const text = input.trim();
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
        // Build history for context
        const history = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const res = await fetch(`${API_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, history }),
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

        // Update memory count after extraction
        if (data.metadata?.memoriesExtracted > 0) {
          setMemoryCount((c) => c + data.metadata.memoriesExtracted);
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
    [input, isLoading, messages]
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

  // ─── Load Profile & Memories ────────────────────────────────────────────

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/profile`);
      const data = await res.json();
      setProfile(data.profile);
    } catch {
      /* silent */
    }
  }, []);

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

  // Load on panel switch
  useEffect(() => {
    if (activePanel === "profile") loadProfile();
    if (activePanel === "memory") loadMemories();
  }, [activePanel, loadProfile, loadMemories]);

  // Initial load for memory count
  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((r) => r.json())
      .then((d) => setMemoryCount(d.memory?.count || 0))
      .catch(() => { });
  }, []);

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
          <div className="sidebar-logo">J</div>
          <div>
            <div className="sidebar-title">J.A.R.V.I.S</div>
            <div className="sidebar-subtitle">Personal AI Assistant</div>
          </div>
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
            className={`sidebar-nav-item ${activePanel === "memory" ? "active" : ""}`}
            onClick={() => { setActivePanel("memory"); setSidebarOpen(false); }}
          >
            🧠 Memory ({memoryCount})
          </button>
        </nav>

        {/* Sidebar panel content */}
        <div className="sidebar-content">
          {activePanel === "profile" && (
            <ProfilePanel profile={profile} />
          )}
          {activePanel === "memory" && (
            <MemoryPanel memories={memories} />
          )}
          {activePanel === "chat" && (
            <div className="empty-state">
              <p>Conversation history appears here.</p>
              <div className="stat-grid" style={{ marginTop: 16 }}>
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
            <div className="welcome-logo">J</div>
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
                </div>
                {msg.role === "assistant" && (
                  <div className="message-actions">
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
          </form>
        </div>
      </main>
    </div>
  );
}

// ─── Sub-Components ─────────────────────────────────────────────────────────

function ProfilePanel({ profile }: { profile: UserProfile | null }) {
  if (!profile) {
    return <div className="empty-state">Loading profile...</div>;
  }

  return (
    <>
      <div className="sidebar-section-title">User Profile (v{profile.version})</div>

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

function MemoryPanel({ memories }: { memories: Memory[] }) {
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
        <div key={m.id} className="memory-item">
          <div className="memory-category">{m.category}</div>
          <div className="memory-content">{m.content}</div>
          <div className="memory-date">
            {new Date(m.createdAt).toLocaleDateString()}
          </div>
        </div>
      ))}
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}
