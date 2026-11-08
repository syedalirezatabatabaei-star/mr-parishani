'use client';

import {
  BottomBar,
  groupItems,
  InboxBell,
  ServiceSearch,
  ShellMenu,
  type DeskItem,
  type LinkComponent,
  type ShellMenuProps,
} from '@sepehr/ui';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const HOME = { href: '/panel', label: 'پیشخوان' };

/**
 * A link of the panel's menu: the doctor chosen (`?workplace=`) goes along, so moving between
 * sections keeps them.
 */
const KeepWorkplace: LinkComponent = ({ href, ...props }) => {
  const workplace = useSearchParams().get('workplace');
  const kept =
    workplace && href !== HOME.href && !href.includes('?') && !href.includes('#')
      ? `${href}?workplace=${encodeURIComponent(workplace)}`
      : href;
  return <Link href={kept} {...props} />;
};

/** The ☰ menu of the center panel, the page you are on marked (owner 1405/08/10). */
export function PanelMenu({
  items,
  ...props
}: Omit<ShellMenuProps, 'groups' | 'currentPath' | 'link' | 'home' | 'label'> & {
  items: readonly DeskItem[];
}) {
  return (
    <ShellMenu
      {...props}
      label="بخش‌های پنل"
      home={HOME}
      groups={groupItems(items)}
      currentPath={usePathname()}
      link={KeepWorkplace}
    />
  );
}

export function PanelSearch({ items }: { items: readonly DeskItem[] }) {
  return <ServiceSearch items={items} link={KeepWorkplace} />;
}

export function PanelBottomBar({ items }: { items: readonly DeskItem[] }) {
  return (
    <BottomBar
      home={{ href: HOME.href, label: 'خانه' }}
      items={items}
      currentPath={usePathname()}
      link={KeepWorkplace}
    />
  );
}

/** The bell and its drawer of the account's own notifications (owner 1405/08/10). */
export function PanelBell() {
  return <InboxBell link={KeepWorkplace} />;
}
