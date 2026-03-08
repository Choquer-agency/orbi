import { useCallback, useRef } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { Sidebar } from '../sidebar/Sidebar';
import { ThreadList } from '../thread-list/ThreadList';
import { EmailViewer } from '../email-viewer/EmailViewer';
import { Header } from './Header';

export function AppLayout() {
  const { sidebarWidth, threadListWidth, setSidebarWidth, setThreadListWidth } = useUiStore();
  const isDragging = useRef<'sidebar' | 'threadList' | null>(null);

  const handleMouseDown = useCallback((panel: 'sidebar' | 'threadList') => {
    isDragging.current = panel;

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging.current === 'sidebar') {
        setSidebarWidth(e.clientX);
      } else if (isDragging.current === 'threadList') {
        const sidebarW = useUiStore.getState().sidebarWidth;
        setThreadListWidth(e.clientX - sidebarW);
      }
    };

    const handleMouseUp = () => {
      isDragging.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [setSidebarWidth, setThreadListWidth]);

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Draggable title bar area for Electron */}
      <div className="titlebar-drag h-[38px] shrink-0 border-b border-gray-200 bg-gray-50">
        <Header />
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div style={{ width: sidebarWidth }} className="shrink-0 border-r border-gray-200">
          <Sidebar />
        </div>

        {/* Resize handle */}
        <div
          className="w-[3px] shrink-0 cursor-col-resize hover:bg-blue-300 active:bg-blue-400"
          onMouseDown={() => handleMouseDown('sidebar')}
        />

        {/* Thread List */}
        <div style={{ width: threadListWidth }} className="shrink-0 border-r border-gray-200">
          <ThreadList />
        </div>

        {/* Resize handle */}
        <div
          className="w-[3px] shrink-0 cursor-col-resize hover:bg-blue-300 active:bg-blue-400"
          onMouseDown={() => handleMouseDown('threadList')}
        />

        {/* Email Viewer */}
        <div className="min-w-0 flex-1">
          <EmailViewer />
        </div>
      </div>
    </div>
  );
}
