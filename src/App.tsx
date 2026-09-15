import { useState, useEffect, useCallback, useMemo, Component, type ReactNode } from 'react';
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import '@tdesign-react/chat/es/style/index.js';

import { useAgents } from './hooks/useAgents';
import { useTheme } from './hooks/useTheme';
import { useSessions } from './hooks/useSessions';
import { useModels } from './hooks/useModels';
import { useChat } from './hooks/useChat';
import { PermissionMode } from './types';

import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { SettingsPage } from './components/SettingsPage';
import { ChatPage } from './pages/ChatPage';
import { BoardPage } from './pages/BoardPage';
import { HostSessionChatView } from './components/host/HostSessionChatView';

/**
 * 全局错误边界
 *
 * 之前任何渲染期异常都会让 React 卸载整棵树 → 用户只看到一片空白，毫无线索。
 * 这里兜住异常并显式呈现，把"白屏"变成"能看懂的错误页"。
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[ErrorBoundary] 渲染异常', error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#05070d',
          color: '#e6edf7',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 720, width: '100%' }}>
          <div style={{ color: '#f472b6', fontSize: 15, letterSpacing: 2, marginBottom: 12 }}>
            // RENDER FAULT
          </div>
          <h1 style={{ fontSize: 26, margin: '0 0 16px', fontWeight: 600 }}>
            界面渲染出错
          </h1>
          <pre
            style={{
              background: 'rgba(244,114,182,0.06)',
              border: '1px solid rgba(244,114,182,0.35)',
              borderRadius: 8,
              padding: 16,
              fontSize: 14.5,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: '0 0 16px',
            }}
          >
            {error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: 'rgba(167,139,250,0.12)',
              border: '1px solid rgba(167,139,250,0.5)',
              color: '#c4b5fd',
              borderRadius: 6,
              padding: '8px 18px',
              fontSize: 15,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

function App() {
  return (
    <ErrorBoundary>
      <Routes>
        {/* 看板为默认入口 */}
        <Route path="/" element={<AppContent />} />
        <Route path="/board" element={<AppContent />} />
        {/*
          ⚠️ "/chat" 必须显式声明！
          此前代码里有 navigate('/chat')（新建对话 / 从看板跳到 Chat），
          但路由表只注册了 "/chat/:sessionId"，导致跳转后无任何 Route 匹配 →
          整页空白且没有后退入口。
        */}
        <Route path="/chat" element={<AppContent />} />
        <Route path="/chat/:sessionId" element={<AppContent />} />
        {/*
          宿主会话的「完整对话」只读视图。
          ⚠️ 必须与 /chat/:sessionId 分开：看板自己的会话在 data/chat.db 里，
             宿主会话只在宿主库里 —— 混用会让 ChatPage 找不到会话而渲染「新对话」页
             （用户报过两次的 bug）。
        */}
        <Route path="/host-session/:sessionId" element={<AppContent />} />
        <Route path="/settings" element={<AppContent />} />
        <Route path="/workspaces" element={<AppContent />} />
        {/* 兜底：未知路径统一回到看板，避免任何情况下出现无解释的白屏 */}
        <Route path="*" element={<AppContent />} />
      </Routes>
    </ErrorBoundary>
  );
}

function AppContent() {
  const navigate = useNavigate();
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();

  /**
   * 页面判定改成显式分类（而不是「不是 A 就是 B」的隐式推断）。
   * 之前任何未注册的路径都会落到 ChatPage 分支渲染出空白页，
   * 且没有任何回退入口。现在未知路径统一重定向回看板。
   */
  const pageKind: 'board' | 'chat' | 'settings' | 'host-session' = (() => {
    const p = location.pathname;
    if (p === '/' || p === '/board') return 'board';
    if (p === '/settings') return 'settings';
    if (p.startsWith('/host-session/')) return 'host-session';
    if (p === '/chat' || p.startsWith('/chat/')) return 'chat';
    return 'board'; // 未知路径按看板处理，配合下方 effect 纠正 URL
  })();

  const isSettingsPage = pageKind === 'settings';
  const isBoardPage = pageKind === 'board';
  const isChatPage = pageKind === 'chat';
  const isHostSessionPage = pageKind === 'host-session';

  // 未知路径 → 把地址栏纠正为 /（渲染层已按看板兜底，这里只同步 URL）
  useEffect(() => {
    const known =
      location.pathname === '/' ||
      location.pathname === '/board' ||
      location.pathname === '/settings' ||
      location.pathname === '/workspaces' ||
      location.pathname === '/chat' ||
      location.pathname.startsWith('/chat/') ||
      location.pathname.startsWith('/host-session/');
    if (!known) navigate('/', { replace: true });
  }, [location.pathname, navigate]);

  // Hooks
  const { theme, toggleTheme } = useTheme();
  const { agents, addAgent, updateAgent, deleteAgent, getAgent } = useAgents();
  const { models, selectedModel, setSelectedModel, fetchModels } = useModels();
  const {
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    currentSession,
    sessionModels,
    fetchSessions,
    deleteSession,
    updateSessionModel,
    addSession,
    updateSession,
    updateSessionMessages,
    loadedSessions,
  } = useSessions();

  // 聊天 Hook
  const {
    isLoading,
    inputValue,
    setInputValue,
    permissionRequest,
    sendMessage,
    handleStop,
    handlePermissionAllow,
    handlePermissionDeny,
  } = useChat({
    currentSession,
    currentSessionId,
    selectedModel,
    getAgent,
    addSession,
    updateSession,
    updateSessionMessages,
    updateSessionModel,
    setCurrentSessionId,
    setSessions,
  });

  // 获取当前会话的 Agent
  const currentAgent = currentSession?.agentId ? getAgent(currentSession.agentId) : getAgent('default');

  // 从 URL 同步 sessionId
  useEffect(() => {
    if (urlSessionId && urlSessionId !== currentSessionId) {
      setCurrentSessionId(urlSessionId);
    } else if (!urlSessionId && !isSettingsPage && currentSessionId) {
      setCurrentSessionId(null);
    }
  }, [urlSessionId, isSettingsPage, currentSessionId, setCurrentSessionId]);
  // 当切换会话时，恢复该会话的模型选择
  useEffect(() => {
    if (currentSessionId && sessionModels[currentSessionId]) {
      setSelectedModel(sessionModels[currentSessionId]);
    } else if (currentSession) {
      setSelectedModel(currentSession.model);
    }
  }, [currentSessionId, sessionModels, currentSession, setSelectedModel]);

  // 初始加载会话列表
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // 更新当前会话的模型
  const updateCurrentSessionModel = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    if (currentSessionId) {
      updateSessionModel(currentSessionId, modelId);
    }
  }, [currentSessionId, updateSessionModel, setSelectedModel]);

  // 删除会话处理
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const navigateTo = await deleteSession(sessionId);
    if (navigateTo) {
      navigate(navigateTo);
    }
  }, [deleteSession, navigate]);

  // 侧边栏事件处理
  const handleNewChat = useCallback(() => {
    setCurrentSessionId(null);
    navigate('/chat');
  }, [navigate, setCurrentSessionId]);

  const handleSelectSession = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId);
    navigate(`/chat/${sessionId}`);
  }, [navigate, setCurrentSessionId]);

  const handleOpenSettings = useCallback(() => {
    navigate('/settings');
  }, [navigate]);

  /**
   * 跳转「完整会话」。
   *
   * 🔴 **存在两套互不相干的会话 id，绝不能共用一个跳转目标** —— 这个坑已经踩过三次：
   *
   *   | 来源 | id 指向 | 正确路由 | 走错的后果 |
   *   |---|---|---|---|
   *   | **看板任务**（`task.session_id`） | 看板自己的 `sessions` 表（`data/chat.db`） | `/chat/:id` | 走 `/host-session/:id` → 「找不到该会话的记录文件」 |
   *   | **宿主会话**（`HostSession.id`） | WorkBuddy 宿主库 | `/host-session/:id` | 走 `/chat/:id` → ChatPage 的 `currentSession` 为 undefined → 渲染成「新对话」页 |
   *
   * ⚠️ 任务那一路**曾经是对的**：早期任务可派发给宿主执行（`executor: 'workbuddy'`），
   *    那时 `task.session_id` 存的确实是**宿主会话 id**，所以跳 `/host-session/:id` 没问题。
   *    后来派发通道下线、执行者只剩 `local` ⇒ `task.session_id` 改存**看板自己的会话 id**，
   *    但跳转目标没跟着改，于是点「查看完整对话」必然报「找不到该会话的记录文件」。
   *
   * ⇒ 所以这里**必须拆成两个 handler**，别再合并。
   */

  /** 看板任务 → 看板自己的会话页（ChatPage） */
  const handleOpenTaskSession = useCallback(
    (sessionId: string) => {
      navigate(`/chat/${encodeURIComponent(sessionId)}`);
    },
    [navigate]
  );

  /**
   * 看板任务引用的会话**是否还在看板库里**。
   *
   * ⚠️ 为什么需要：`task.session_id` 只存 id，会话本身可能已被清理
   *    （实测用户库里就有这种任务）。此时点「查看完整对话」会进 ChatPage 并渲染成
   *    **「新对话」页** —— 用户会以为"点进去变成新对话"是新 bug，其实是记录真没了。
   *    所以在源头判定，记录不存在就不给入口（按钮置灰并说明原因）。
   */
  const sessionIdSet = useMemo(() => new Set(sessions.map(s => s.id)), [sessions]);
  const taskSessionExists = useCallback(
    (sessionId: string) => sessionIdSet.has(sessionId),
    [sessionIdSet]
  );

  /** 宿主会话 → 只读的宿主会话查看页（HostSessionChatView） */
  const handleOpenHostSession = useCallback(
    (sessionId: string) => {
      navigate(`/host-session/${encodeURIComponent(sessionId)}`);
    },
    [navigate]
  );

  // Sidebar 状态
  const [sidebarOpen, setSidebarOpen] = useState(false);
  
  // 权限模式状态
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  return (
    <div 
      className="flex h-screen w-screen"
      style={{ backgroundColor: 'var(--td-bg-color-page)' }}
    >
      {/* 侧边栏：看板页与宿主会话只读页都不需要看板的会话列表
          （宿主会话页自带「返回看板」，挂上看板侧栏会让人误以为在看板的对话里） */}
      {!isBoardPage && !isHostSessionPage && (
        <Sidebar
          sessions={sessions}
          currentSessionId={currentSessionId}
          isSettingsPage={isSettingsPage}
          sidebarOpen={sidebarOpen}
          agents={agents}
          getAgent={getAgent}
          onNewChat={handleNewChat}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onOpenSettings={handleOpenSettings}
        />
      )}

      {/* 主内容区 */}
      <main 
        className="flex-1 flex flex-col min-w-0"
        style={{ backgroundColor: isBoardPage ? undefined : 'var(--td-bg-color-page)' }}
      >
        {/* 顶部栏（宿主会话只读页自带头部，不复用看板 Header） */}
        {!isHostSessionPage && !isBoardPage && (
          <Header
            isSettingsPage={isSettingsPage}
            sidebarOpen={sidebarOpen}
            theme={theme}
            currentSession={currentSession}
            currentAgent={currentAgent}
            models={models}
            onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
            onToggleTheme={toggleTheme}
            onRefreshModels={fetchModels}
            onBack={() => navigate('/')}
          />
        )}

        {/* 页面主体：显式分支，未知路径由 pageKind 归入看板 */}
        {isHostSessionPage ? (
          <HostSessionChatView />
        ) : isSettingsPage ? (
          <SettingsPage
            agents={agents}
            onAdd={addAgent}
            onUpdate={updateAgent}
            onDelete={deleteAgent}
          />
        ) : isChatPage ? (
          <ChatPage
            currentSession={currentSession}
            models={models}
            selectedModel={selectedModel}
            agents={agents}
            isLoading={isLoading}
            inputValue={inputValue}
            permissionRequest={permissionRequest}
            permissionMode={permissionMode}
            onSendMessage={sendMessage}
            onStop={handleStop}
            onInputChange={setInputValue}
            onModelChange={updateCurrentSessionModel}
            onPermissionAllow={handlePermissionAllow}
            onPermissionDeny={handlePermissionDeny}
            onPermissionModeChange={setPermissionMode}
            messagesLoaded={currentSessionId ? loadedSessions.has(currentSessionId) : false}
          />
        ) : (
          <BoardPage
            onOpenSession={handleOpenTaskSession}
            onOpenHostSession={handleOpenHostSession}
            taskSessionExists={taskSessionExists}
            onOpenChat={() => navigate('/chat')}
            onOpenSettings={handleOpenSettings}
          />
        )}
      </main>
    </div>
  );
}

export default App;
