import { useState, useEffect, useCallback } from 'react';
import { Session, Message } from '../types';
import { storageGetJSON, storageSetJSON } from '../utils/safeStorage';

const STORAGE_KEYS = {
  sessionModels: 'sessionModels',
};

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  /**
   * 消息**已加载过**的会话 id 集合 —— 用来区分「加载中」与「真的没有消息」。
   * ⚠️ 没有它，ChatPage 会把"消息还没回来"误判成"新对话"，闪出 NewChatView
   *    （其标题是 APP_CONFIG.name「任务看板」，会被误认为跳回看板）。
   */
  const [loadedSessions, setLoadedSessions] = useState<Set<string>>(() => new Set());
  
  // 每个会话的模型选择缓存
  const [sessionModels, setSessionModels] = useState<Record<string, string>>(() =>
    // 渲染期同步读 ⇒ 统一走 safeStorage（原本自带 try/catch，收敛到同一个入口，避免口径漂移）
    storageGetJSON<Record<string, string>>(STORAGE_KEYS.sessionModels, {})
  );

  // 获取当前会话
  const currentSession = sessions.find(s => s.id === currentSessionId);

  // 从 API 加载会话列表
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      
      if (data.sessions) {
        const loadedSessions: Session[] = data.sessions.map((s: any) => ({
          id: s.id,
          title: s.title,
          model: s.model,
          createdAt: new Date(s.created_at),
          messages: []
        }));
        setSessions(loadedSessions);
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    }
  }, []);

  // 加载单个会话的消息
  const loadSessionMessages = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      const data = await res.json();
      
      if (data.messages) {
        const messages: Message[] = data.messages.map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          model: m.model,
          timestamp: new Date(m.created_at),
          toolCalls: m.tool_calls || undefined
        }));
        
        setSessions(prev => prev.map(s => 
          s.id === sessionId ? { ...s, messages } : s
        ));
      }
    } catch (error) {
      console.error('Failed to load session messages:', error);
    } finally {
      /**
       * 🔴 标记「这个会话的消息已经拉过了」（**无论是否为空**）。
       *
       * 2026-09-15 修（用户报「点『查看完整对话』跳到任务看板」）：
       *   `fetchSessions()` 给每个会话的初始值是 `messages: []`，消息是**异步再拉**的。
       *   而 ChatPage 用 `messages.length === 0` 判断"这是新对话"，于是路由刚切过去、
       *   消息还没回来时，它会渲染 `NewChatView` —— 那个视图的大标题正是
       *   `APP_CONFIG.name`（=「任务看板」）⇒ 用户以为"跳回看板"了。
       *   已完成的任务因为消息早已加载过，所以不出问题（现象与用户描述完全吻合）。
       *   ⇒ 必须把「加载中」与「空会话」区分开。
       */
      setLoadedSessions(prev => (prev.has(sessionId) ? prev : new Set(prev).add(sessionId)));
    }
  }, []);

  // 删除会话
  const deleteSession = useCallback(async (sessionId: string): Promise<string | null> => {
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      
      let navigateTo: string | null = null;
      
      setSessions(prev => {
        const filtered = prev.filter(s => s.id !== sessionId);
        return filtered;
      });
      
      // 返回需要导航到的位置
      const remaining = sessions.filter(s => s.id !== sessionId);
      if (currentSessionId === sessionId) {
        if (remaining.length > 0) {
          navigateTo = `/chat/${remaining[0].id}`;
          setCurrentSessionId(remaining[0].id);
        } else {
          navigateTo = '/';
          setCurrentSessionId(null);
        }
      }
      
      return navigateTo;
    } catch (error) {
      console.error('Failed to delete session:', error);
      return null;
    }
  }, [sessions, currentSessionId]);

  // 保存每个会话的模型选择到 localStorage
  const updateSessionModel = useCallback((sessionId: string, modelId: string) => {
    setSessionModels(prev => {
      const updated = { ...prev, [sessionId]: modelId };
      // setState 的更新函数内抛错会卸载整棵树 ⇒ 同样必须走 safeStorage
      storageSetJSON(STORAGE_KEYS.sessionModels, updated);
      return updated;
    });
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, model: modelId } : s
    ));
  }, []);

  // 添加新会话
  const addSession = useCallback((session: Session) => {
    setSessions(prev => [session, ...prev]);
    setCurrentSessionId(session.id);
  }, []);

  // 更新会话
  const updateSession = useCallback((sessionId: string, updates: Partial<Session>) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, ...updates } : s
    ));
  }, []);

  // 更新会话消息
  const updateSessionMessages = useCallback((sessionId: string, updater: (messages: Message[]) => Message[]) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, messages: updater(s.messages) } : s
    ));
  }, []);

  // 当切换会话时，加载该会话的消息
  useEffect(() => {
    if (!currentSessionId) return;

    /**
     * 🔴 2026-09-16 修（精读 B-H1）：判据必须是 `loadedSessions`，
     *    **不能**用 `session.messages.length === 0`。
     *
     * 为什么原判据会形成**请求风暴**：
     *   `loadSessionMessages` 成功时会 `setSessions(prev => prev.map(...))` ——
     *   即使后端返回的是**空数组**，`map` 也会产出一个**新的数组引用**；
     *   于是本 effect 的 `sessions` 依赖变化 → 再跑一次 →
     *   而空会话的 `messages.length` **仍然**是 0 ⇒ 又发一次请求 ⇒ 无限循环。
     *   一个"没有消息的会话"被选中，就会持续打 `/api/sessions/:id`。
     *
     * `loadedSessions` 正是为这个场景存在的：`loadSessionMessages` 的 `finally` 里
     * **无论拉到的消息是否为空**都会把它标记上（见该处的长注释：要把"加载中"
     * 与"空会话"区分开，否则 ChatPage 会把加载中误判成新对话）。
     *
     * ⚠️ 同时**去掉了 `sessions` 依赖**：新逻辑不再读它，留着只会让 effect
     *    在每次列表变化（含 SSE/轮询引起的）时白跑一遍。
     */
    if (loadedSessions.has(currentSessionId)) return;
    loadSessionMessages(currentSessionId);
  }, [currentSessionId, loadSessionMessages, loadedSessions]);

  return {
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    currentSession,
    sessionModels,
    fetchSessions,
    loadSessionMessages,
    /** 消息已加载过的会话 id 集合（区分「加载中」与「空会话」，见其 useState 注释） */
    loadedSessions,
    deleteSession,
    updateSessionModel,
    addSession,
    updateSession,
    updateSessionMessages,
  };
}
