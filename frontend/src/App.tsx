import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LanguageProvider } from "./i18n";
import Layout from "./components/Layout";
import LoginPage from "./components/LoginPage";
import DashboardPage from "./components/DashboardPage";
import ShareDetailPage from "./components/ShareDetailPage";
import UploadPage from "./components/UploadPage";
import CreateRequestPage from "./components/CreateRequestPage";
import PublicResolver from "./components/PublicResolver";
import CostPage from "./components/CostPage";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { WorkspaceProvider } from "./context/WorkspaceContext";
import { useWorkspace } from "./context/workspace";
import UsersPage from "./components/UsersPage";
import PasswordPage from "./components/PasswordPage";

function AdminRoute({ children }: { children: ReactNode }) {
  return useAuth().user?.role === "admin" ? children : <Navigate to="/dashboard" replace />;
}

function WorkspaceLayout() {
  const { target, manage } = useWorkspace();
  return <Layout key={`${target?.id || "own"}:${manage}`} />;
}

function AuthenticatedLayout() {
  const { user } = useAuth();
  return <WorkspaceProvider key={`${user?.id}:${user?.role}:${!!user?.password_change_required}`}><WorkspaceLayout /></WorkspaceProvider>;
}

function WritableRoute({ children }: { children: ReactNode }) {
  return useWorkspace().readOnly ? <Navigate to="/dashboard" replace /> : children;
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-dvh page-bg flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (user.password_change_required && location.pathname !== "/account") return <Navigate to="/account" replace />;
  return <>{children}</>;
}

function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-dvh page-bg flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (user) return <Navigate to={user.password_change_required ? "/account" : "/dashboard"} replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public auth */}
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />
      <Route path="/set-password" element={<PasswordPage setup />} />

      {/* Public share/request pages */}
      <Route path="/:id" element={<LanguageProvider><PublicResolver /></LanguageProvider>} />

      {/* Protected */}
      <Route
        element={
          <ProtectedRoute>
            <AuthenticatedLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/shares/:id" element={<ShareDetailPage />} />
        <Route path="/upload" element={<WritableRoute><UploadPage /></WritableRoute>} />
        <Route path="/requests/new" element={<WritableRoute><CreateRequestPage /></WritableRoute>} />
        <Route path="/cost" element={<AdminRoute><CostPage /></AdminRoute>} />
        <Route path="/users" element={<AdminRoute><UsersPage /></AdminRoute>} />
        <Route path="/account" element={<PasswordPage />} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
