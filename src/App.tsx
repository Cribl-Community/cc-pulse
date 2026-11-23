import { lazy, Suspense } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useHref, useLocation, useNavigate } from 'react-router-dom';
import { Alert, RouterProvider, Spinner, VerticalNavigation } from '@capra/core';
import { Book, Cog, DatabaseOutlined, HistoryOutlined, HomeOutlined, IdCard, WorkersOutlined } from '@capra/icons';
import { PulseProvider, TimeScopeProvider } from './state';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Unwired } from './components/Unwired';
import { hostMode } from './lib/host';
import { SetupGuide } from './components/SetupGuide';
import { useScopeNotice } from './scopeContext';
import type { SettingsTab } from './lib/nav';

const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })));
const Groups = lazy(() => import('./pages/Groups').then((m) => ({ default: m.Groups })));
const GroupDetail = lazy(() => import('./pages/Groups').then((m) => ({ default: m.GroupDetail })));
const Assets = lazy(() => import('./pages/Assets').then((m) => ({ default: m.Assets })));
const Asset = lazy(() => import('./pages/Asset').then((m) => ({ default: m.Asset })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const Incidents = lazy(() => import('./pages/Incidents').then((m) => ({ default: m.Incidents })));
const Identity = lazy(() => import('./pages/Identity').then((m) => ({ default: m.Identity })));

/* Spec 013 §1: five primary items; config lives under the Settings footer item as tabs. */
const NAV = [
  { to: '/', label: 'Overview', icon: HomeOutlined },
  { to: '/incidents', label: 'Incidents', icon: HistoryOutlined },
  { to: '/assets', label: 'Assets', icon: DatabaseOutlined },
  { to: '/groups', label: 'Worker groups', icon: WorkersOutlined },
  { to: '/identity', label: 'Identity', icon: IdCard },
];

/** Old config routes (still linked from alerts and docs) → their Settings tab, keeping the query string. */
export function LegacyRedirect({ tab }: { tab: SettingsTab }) {
  const { search } = useLocation();
  return <Navigate to={`/settings/${tab}${search}`} replace />;
}

/** Spec 041: /deploy no longer has a tab — land on Setup, keeping the query string. */
export function LegacyDeployRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/settings/setup${search}`} replace />;
}

/** The route table. Hook-free so tests can read it with createRoutesFromChildren. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Overview />} />
      <Route path="/groups" element={<Groups />} /><Route path="/groups/:group" element={<GroupDetail />} />
      <Route path="/assets" element={<Assets />} /><Route path="/assets/:asset" element={<Asset />} />
      <Route path="/incidents" element={<Incidents />} /><Route path="/identity" element={<Identity />} />
      <Route path="/settings" element={<LegacyRedirect tab="general" />} />
      <Route path="/settings/:tab" element={<Settings />} />
      <Route path="/thresholds" element={<LegacyRedirect tab="thresholds" />} />
      <Route path="/policies" element={<LegacyRedirect tab="policies" />} />
      <Route path="/alerts" element={<LegacyRedirect tab="alerts" />} />
      <Route path="/deploy" element={<LegacyDeployRedirect />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function Shell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const notice = useScopeNotice();
  const active = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));
  return (
    <RouterProvider navigate={(to) => navigate(to)} useHref={useHref}>
      <div className="shell">
        <VerticalNavigation>
          <VerticalNavigation.ItemList>
            {NAV.map((n) => <VerticalNavigation.Item key={n.to} as={Link} to={n.to} icon={<n.icon />} label={n.label} isActive={active(n.to)} />)}
          </VerticalNavigation.ItemList>
          <VerticalNavigation.Footer>
            <VerticalNavigation.Item as={Link} to="/settings/general" icon={<Cog />} label="Settings" isActive={active('/settings')} />
            <VerticalNavigation.Item href="https://github.com/Cribl-Community/cc-pulse#readme" target="_blank" icon={<Book />} label="Documentation" />
          </VerticalNavigation.Footer>
        </VerticalNavigation>
        <main className="main">
          {notice && <Alert appearance="info" onDismiss>{notice}</Alert>}
          <Suspense fallback={<Spinner />}>
            <ErrorBoundary key={pathname}>
              <AppRoutes />
            </ErrorBoundary>
          </Suspense>
        </main>
      </div>
    </RouterProvider>
  );
}

export default function App() {
  if (hostMode() === 'unwired') return <Unwired />;
  return <BrowserRouter basename={window.CRIBL_BASE_PATH}><TimeScopeProvider><PulseProvider><SetupGuide><Shell /></SetupGuide></PulseProvider></TimeScopeProvider></BrowserRouter>;
}
