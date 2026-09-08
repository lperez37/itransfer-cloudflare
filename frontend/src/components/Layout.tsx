import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { usePWAInstall } from "../hooks/usePWAInstall";
import {
  LayoutDashboard,
  DollarSign,
  LogOut,
  Menu,
  X,
  Download,
  Search,
  Github,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import logoSvg from "../assets/logo.svg";
import { Users, UserRound } from "lucide-react";
import { useWorkspace } from "../context/workspace";
import ConfirmPassword from "./ConfirmPassword";

export default function Layout() {
  const { user, logout } = useAuth();
  const passwordChangeRequired = !!user?.password_change_required;
  const navigate = useNavigate();
  const location = useLocation();
  const { target, manage, view } = useWorkspace();
  const [confirmManage, setConfirmManage] = useState(false);
  const workspaceRoute = location.pathname === "/dashboard" || location.pathname === "/upload" || location.pathname.startsWith("/shares/") || location.pathname.startsWith("/requests/");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const toggleSearch = () => {
    if (passwordChangeRequired) return;
    if (searchOpen) {
      setSearch("");
      setSearchOpen(false);
    } else {
      // Search filters the dashboard lists, so make sure we are there.
      if (location.pathname !== "/dashboard") navigate("/dashboard");
      setSearchOpen(true);
    }
  };
  const { canInstall, install } = usePWAInstall();
  const [installDismissed, setInstallDismissed] = useState(
    () => sessionStorage.getItem("pwa-install-dismissed") === "1"
  );

  const showInstallBanner = canInstall && !installDismissed;

  const handleInstall = async () => {
    await install();
  };

  const dismissInstall = () => {
    setInstallDismissed(true);
    sessionStorage.setItem("pwa-install-dismissed", "1");
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // The local session is already cleared; warn that the server sign-out
      // failed so the user can retry from another device if needed. Surfaced
      // on the login page since this component unmounts on redirect.
      try {
        sessionStorage.setItem(
          "logout-error",
          "You were signed out locally, but the server sign-out failed."
        );
      } catch {
        /* sessionStorage unavailable - non-fatal */
      }
    } finally {
      navigate("/login");
    }
  };

  const navItems = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    ...(user?.role === "admin" ? [{ to: "/users", label: "Users", icon: Users }, { to: "/cost", label: "Costs", icon: DollarSign }] : []),
    { to: "/account", label: "Account", icon: UserRound },
  ].filter((item) => !passwordChangeRequired || item.to === "/account");

  return (
    <div className="min-h-dvh page-bg">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-sm border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          {/* Logo */}
          <NavLink to={passwordChangeRequired ? "/account" : "/dashboard"} className="flex items-center gap-2.5 group">
            <img src={logoSvg} alt="iTransfer" className="w-7 h-7" />
            <span className="text-lg font-bold text-primary font-[family-name:var(--font-display)]">
              iTransfer
            </span>
          </NavLink>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-150 ${
                    isActive
                      ? "bg-primary/10 text-primary-light"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-light"
                  }`
                }
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* User / Mobile Toggle */}
          <div className="flex items-center gap-1 sm:gap-3">
            {!passwordChangeRequired && <button
              onClick={toggleSearch}
              aria-label="Search"
              className={`p-2 rounded-md transition-colors ${
                searchOpen
                  ? "bg-primary/10 text-primary-light"
                  : "text-text-secondary hover:bg-surface-light hover:text-text-primary"
              }`}
            >
              <Search className="w-5 h-5" />
            </button>}
            <div className="hidden sm:flex items-center gap-2 text-sm text-text-secondary">
              <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center text-background font-semibold text-xs">
                {user?.email?.[0]?.toUpperCase() || "U"}
              </div>
              <span className="hidden lg:inline">{user?.email}</span>
            </div>
            <button
              onClick={handleLogout}
              aria-label="Logout"
              className="hidden md:flex items-center gap-1.5 text-sm text-text-muted hover:text-danger transition-colors px-3 py-1.5 rounded-md hover:bg-danger/10"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden lg:inline">Logout</span>
            </button>
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileOpen}
              className="md:hidden p-2 rounded-md hover:bg-surface-light text-text-secondary"
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Search bar */}
        {searchOpen && !passwordChangeRequired && (
          <div className="border-t border-border animate-fade-in">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 relative">
              <Search className="absolute left-7 sm:left-9 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
              <input
                ref={searchInputRef}
                type="search"
                aria-label="Search shares and requests"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") toggleSearch(); }}
                placeholder="Search shares and requests by title or link…"
                className="w-full bg-surface-light border border-border rounded-md pl-9 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
              />
            </div>
          </div>
        )}

        {/* Mobile Nav */}
        {mobileOpen && (
          <div className="md:hidden border-t border-border animate-fade-in">
            <div className="px-4 py-3 space-y-1">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-4 py-3 rounded-md text-sm font-medium transition-all ${
                      isActive
                        ? "bg-primary/10 text-primary-light"
                        : "text-text-secondary hover:bg-surface-light"
                    }`
                  }
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </NavLink>
              ))}
              <button
                onClick={handleLogout}
                className="flex items-center gap-3 px-4 py-3 rounded-md text-sm font-medium text-danger/80 hover:bg-danger/10 w-full"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </div>
        )}
      </header>

      {/* PWA Install Banner */}
      {showInstallBanner && (
        <div className="bg-primary/10 border-b border-primary/20 animate-fade-in">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-sm">
              <Download className="w-4 h-4 text-primary shrink-0" />
              <span className="text-text-secondary">
                Install <strong className="text-text-primary">iTransfer</strong> for quick access
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleInstall}
                className="px-3 py-1 rounded-md text-xs font-semibold bg-primary text-background hover:bg-primary-light transition-colors"
              >
                Install
              </button>
              <button
                onClick={dismissInstall}
                className="p-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-light transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {target && workspaceRoute && <section aria-label="Workspace viewing mode" className="surface rounded-lg p-4 mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-text-primary">
          <div className="min-w-0"><p className="font-semibold break-words">Viewing {target.name}'s workspace</p><p className="text-sm text-text-secondary mt-1">{manage ? "Management enabled. Changes affect this user's files." : "Read-only. You can browse and download files."} You remain signed in as {user?.name}.</p></div>
          <div className="flex flex-wrap gap-2 shrink-0 text-sm"><button className="btn-secondary" onClick={() => { view(null); navigate("/dashboard"); }}>Return to my workspace</button>{manage ? <button className="btn-secondary" onClick={() => view(target)}>Return to read-only</button> : <button className="btn-primary" onClick={() => setConfirmManage(true)}>Enable management</button>}</div>
        </section>}
        <Outlet context={{ search }} />
      </main>
      {confirmManage && target && <ConfirmPassword title="Enable workspace management" description={`Allow changes to ${target.name}'s shares and requests. This does not change your signed-in identity.`} onCancel={() => setConfirmManage(false)} onConfirm={async () => { view(target, true); }} />}

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-4 sm:px-6 pb-6 flex justify-center">
        <a
          href="https://github.com/lperez37/itransfer-cloudflare"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          <Github className="w-3.5 h-3.5" />
          iTransfer on GitHub
        </a>
      </footer>
    </div>
  );
}
