import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Tooltip } from 'radix-ui';
import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router';

import { Sidebar } from './components/Sidebar';
import { Spinner, ToastProvider } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import './styles.css';

// The spreadsheet engine and the data grid are large: load them only when needed.
const WorkbookPage = lazy(() => import('./pages/WorkbookPage').then((m) => ({ default: m.WorkbookPage })));
const DatabasePage = lazy(() => import('./pages/DatabasePage').then((m) => ({ default: m.DatabasePage })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  return user ? children : <Navigate to="/login" replace />;
}

function Shell() {
  return (
    <RequireAuth>
      <div className="relative flex h-full gap-4 p-4">
        <Sidebar />
        <Suspense
          fallback={
            <main className="window relative z-10 flex flex-1 items-center justify-center">
              <Spinner className="size-6" />
            </main>
          }
        >
          <Outlet />
        </Suspense>
      </div>
    </RequireAuth>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<Shell />}>
                  <Route index element={<HomePage view="all" />} />
                  <Route path="recent" element={<HomePage key="recent" view="recent" />} />
                  <Route path="favorites" element={<HomePage key="favorites" view="favorites" />} />
                  <Route path="shared" element={<HomePage key="shared" view="shared" />} />
                  <Route path="w/:workspaceId" element={<HomePage view="all" />} />
                  <Route path="book/:id" element={<WorkbookPage />} />
                  <Route path="db" element={<DatabasePage />} />
                  <Route path="db/:connectionId" element={<DatabasePage />} />
                  <Route path="db/:connectionId/t/:schema/:table" element={<DatabasePage />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
