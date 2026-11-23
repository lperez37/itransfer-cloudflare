import { useEffect, useRef, useState } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  DollarSign,
  Download,
  Github,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  UserRound,
  Users,
  X,
} from "lucide-react";
import logoSvg from "../assets/logo.svg";
import { useAuth } from "../context/AuthContext";
import { useWorkspace } from "../context/workspace";
import { usePWAInstall } from "../hooks/usePWAInstall";
import ConfirmPassword from "./ConfirmPassword";

export default function Layout() {
  const { user, logout } = useAuth();
  const { target, manage, view } = useWorkspace();
  const { canInstall, install } = usePWAInstall();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [confirmManage, setConfirmManage] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [installDismissed, setInstallDismissed] = useState(() => {
    try {
      return sessionStorage.getItem("pwa-install-dismissed") === "1";
    } catch {
      return false;
    }
  });
  const mobileToggle = useRef<HTMLButtonElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const passwordChangeRequired = Boolean(user?.password_change_required);
  const workspaceRoute = pathname === "/dashboard" || pathname === "/upload"
    || pathname.startsWith("/shares/") || pathname.startsWith("/requests/");
  const avatar = user?.email?.[0]?.toUpperCase() || "U";
  const navItems = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    ...(user?.role === "admin" ? [
      { to: "/users", label: "Users", icon: Users },
      { to: "/cost", label: "Costs", icon: DollarSign },
    ] : []),
    { to: "/account", label: "Account", icon: UserRound },
  ].filter((item) => !passwordChangeRequired || item.to === "/account");

  const navLinks = navItems.map((item) => (
    <NavLink
      key={item.to}
      to={item.to}
      onClick={() => setMobileOpen(false)}
      className="workspace-nav-link"
    >
      <item.icon className="size-4 shrink-0" aria-hidden="true" />
      {item.label}
    </NavLink>
  ));

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  function closeSearch() {
    setSearch("");
    setSearchOpen(false);
    searchToggle.current?.focus();
  }

  function toggleSearch() {
    if (passwordChangeRequired) return;
    if (searchOpen) {
      closeSearch();
      return;
    }

    setMobileOpen(false);
    if (pathname !== "/dashboard") navigate("/dashboard");
    setSearchOpen(true);
  }

  function dismissInstall() {
    setInstallDismissed(true);
    try {
      sessionStorage.setItem("pwa-install-dismissed", "1");
    } catch {
      // The dismissal still applies while this layout is mounted.
    }
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {
      try {
        sessionStorage.setItem(
          "logout-error",
          "You were signed out locally, but the server sign-out failed."
        );
      } catch {
        /* sessionStorage unavailable */
      }
    } finally {
      navigate("/login");
    }
  }

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <a
        href="#workspace-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-4 focus:z-60 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:text-primary"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-50 border-b border-border bg-surface/95 backdrop-blur-sm">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6">
          <NavLink
            to={passwordChangeRequired ? "/account" : "/dashboard"}
            onClick={() => setMobileOpen(false)}
            className="inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg font-display text-xl font-bold tracking-tight text-text-primary"
          >
            <img src={logoSvg} alt="" width="36" height="36" />
            iTransfer
          </NavLink>

          <nav aria-label="Main navigation" className="hidden flex-1 items-center gap-1 md:flex">
            {navLinks}
          </nav>

          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            {!passwordChangeRequired && (
              <button
                type="button"
                ref={searchToggle}
                onClick={toggleSearch}
                aria-label={searchOpen ? "Close search" : "Search"}
                aria-expanded={searchOpen}
                aria-controls="workspace-search"
                className="icon-button"
              >
                {searchOpen
                  ? <X className="size-5" aria-hidden="true" />
                  : <Search className="size-5" aria-hidden="true" />}
              </button>
            )}

            <div className="hidden min-w-0 items-center gap-2 border-s border-border ps-3 md:flex" title={user?.email}>
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-container text-sm font-semibold text-on-primary-container" aria-hidden="true">
                {avatar}
              </span>
              <span className="sr-only xl:not-sr-only xl:max-w-44 xl:truncate xl:text-sm xl:text-text-secondary">
                {user?.email}
              </span>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              aria-label="Logout"
              title="Logout"
              className="icon-button hidden hover:bg-danger/10 hover:text-danger md:inline-flex"
            >
              <LogOut className="size-[1.125rem]" aria-hidden="true" />
            </button>
            <button
              type="button"
              ref={mobileToggle}
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileOpen}
              aria-controls="mobile-navigation"
              className="icon-button md:hidden"
            >
              {mobileOpen
                ? <X className="size-5" aria-hidden="true" />
                : <Menu className="size-5" aria-hidden="true" />}
            </button>
          </div>
        </div>

        {!passwordChangeRequired && (
          <div id="workspace-search" role="search" hidden={!searchOpen} className="border-t border-border">
            <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
              <div className="relative w-full md:max-w-lg">
                <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
                <input
                  ref={searchInput}
                  type="search"
                  aria-label="Search shares and requests"
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeSearch();
                    }
                  }}
                  placeholder="Search shares and requests by title or link…"
                  className="input-field ps-10"
                />
              </div>
            </div>
          </div>
        )}

        <nav
          id="mobile-navigation"
          aria-label="Main navigation"
          hidden={!mobileOpen}
          className="max-h-[calc(100dvh-8.5rem)] overflow-y-auto border-t border-border md:hidden"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setMobileOpen(false);
              mobileToggle.current?.focus();
            }
          }}
        >
          <div className="grid gap-1 px-4 py-3 sm:px-6">
            {user?.email && (
              <div className="mb-1 flex min-w-0 items-center gap-2.5 px-3 py-2 text-sm text-text-secondary">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-container font-semibold text-on-primary-container" aria-hidden="true">
                  {avatar}
                </span>
                <span className="min-w-0 truncate" title={user.email}>{user.email}</span>
              </div>
            )}
            {navLinks}
            <button
              type="button"
              onClick={handleLogout}
              className="workspace-nav-link text-danger hover:bg-danger/10 hover:text-danger"
            >
              <LogOut className="size-4 shrink-0" aria-hidden="true" />
              Logout
            </button>
          </div>
        </nav>
      </header>

      {canInstall && !installDismissed && (
        <div className="mx-auto mt-4 w-full max-w-7xl px-4 sm:px-6">
          <div className="flex items-center justify-between gap-2 rounded-2xl bg-primary-container px-3 py-2 text-on-primary-container sm:px-4">
            <p className="flex items-center gap-2.5 text-sm">
              <Download className="hidden size-5 shrink-0 min-[350px]:block" aria-hidden="true" />
              <span>Install <strong>iTransfer</strong> for quick access</span>
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={install} className="btn-primary px-3 text-sm">
                Install
              </button>
              <button
                type="button"
                onClick={dismissInstall}
                aria-label="Dismiss install prompt"
                className="icon-button text-on-primary-container"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}

      <main id="workspace-content" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 scroll-mt-32 px-4 py-6 sm:px-6 sm:py-8">
        {target && workspaceRoute && (
          <section
            aria-label="Workspace viewing mode"
            className={`mb-6 flex flex-col justify-between gap-4 rounded-2xl p-4 lg:flex-row lg:items-center ${manage ? "bg-warning-container text-on-warning-container" : "bg-accent-container text-on-accent-container"}`}
          >
            <div className="min-w-0 wrap-anywhere">
              <p className="font-semibold">Viewing {target.name}'s workspace</p>
              <p className="mt-1 text-sm">
                {manage ? "Management enabled. Changes affect this user's files." : "Read-only. You can browse and download files."} You remain signed in as {user?.name}.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 text-sm">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  view(null);
                  navigate("/dashboard");
                }}
              >
                Return to my workspace
              </button>
              {manage ? (
                <button type="button" className="btn-secondary" onClick={() => view(target)}>
                  Return to read-only
                </button>
              ) : (
                <button type="button" className="btn-primary" onClick={() => setConfirmManage(true)}>
                  Enable management
                </button>
              )}
            </div>
          </section>
        )}
        <Outlet context={{ search }} />
      </main>

      {confirmManage && target && (
        <ConfirmPassword
          title="Enable workspace management"
          description={`Allow changes to ${target.name}'s shares and requests. This does not change your signed-in identity.`}
          onCancel={() => setConfirmManage(false)}
          onConfirm={async () => { view(target, true); }}
        />
      )}

      <footer className="flex justify-center px-4 pb-4 sm:px-6">
        <a
          href="https://github.com/lperez37/itransfer-cloudflare"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs text-text-muted hover:text-text-primary"
        >
          <Github className="size-4" aria-hidden="true" />
          iTransfer on GitHub
        </a>
      </footer>
    </div>
  );
}
