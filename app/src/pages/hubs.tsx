import { useState } from 'react';
import { PluginInstall } from './PluginInstall';
import { PluginMarket } from './PluginMarket';
import { AppStore } from './AppStore';
import { AppsMarket } from './AppsMarket';
import type { AdbManager } from '../lib/adb';
import type { DeviceConnection } from '../lib/device';

interface HubProps {
  adb: AdbManager | null;
  conn: DeviceConnection | null;
  connected: boolean;
  connectionType: 'usb' | 'ssh';
  onLog: (msg: string) => void;
}

function Segmented<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg bg-[#f1f5f9] p-0.5">
      {options.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)}
          className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
            value === o.id ? 'bg-white text-[#0f172a] shadow-sm font-medium' : 'text-[#64748b] hover:text-[#0f172a]'
          }`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const PLUGIN_TABS = [
  { id: 'local' as const, label: '本地安装' },
  { id: 'market' as const, label: '插件市场' },
];

const APP_TABS = [
  { id: 'local' as const, label: '上传安装' },
  { id: 'market' as const, label: '安装包市场' },
];

export function PluginsHub(props: HubProps) {
  const [tab, setTab] = useState<'local' | 'market'>(
    () => (localStorage.getItem('pluginsHubTab') === 'market' ? 'market' : 'local'),
  );
  const change = (t: 'local' | 'market') => {
    setTab(t);
    try { localStorage.setItem('pluginsHubTab', t); } catch { /* noop */ }
  };
  return (
    <div className="space-y-4">
      <Segmented value={tab} onChange={change} options={PLUGIN_TABS} />
      {tab === 'local' ? (
        <PluginInstall
          adb={props.adb}
          connected={props.connected}
          connectionType={props.connectionType}
          onLog={props.onLog}
        />
      ) : (
        <PluginMarket conn={props.conn} connected={props.connected} onLog={props.onLog} />
      )}
    </div>
  );
}

export function AppsHub(props: HubProps) {
  const [tab, setTab] = useState<'local' | 'market'>(
    () => (localStorage.getItem('appsHubTab') === 'market' ? 'market' : 'local'),
  );
  const change = (t: 'local' | 'market') => {
    setTab(t);
    try { localStorage.setItem('appsHubTab', t); } catch { /* noop */ }
  };
  return (
    <div className="space-y-4">
      <Segmented value={tab} onChange={change} options={APP_TABS} />
      {tab === 'local' ? (
        <AppStore conn={props.conn} connected={props.connected} onLog={props.onLog} />
      ) : (
        <AppsMarket conn={props.conn} connected={props.connected} onLog={props.onLog} />
      )}
    </div>
  );
}
