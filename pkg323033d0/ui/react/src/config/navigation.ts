/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import { Database, Map, Radio, Route } from 'lucide-react';

import { NavigationItem } from '@/types/navigation';

/**
 * Navigation configuration for the application.
 *
 * The order is the intended reading order of the demo: look at the twin, run a
 * dispatch against it, then audit where every number came from. Each path must
 * match a `<Route>` in `App.tsx`.
 */
export const navigationConfig: NavigationItem[] = [
  {
    id: 'ops',
    path: '/',
    icon: Radio,
    iconActive: Radio,
    label: 'Operations',
    tooltip: 'The live control room view of the isthmus',
  },
  {
    id: 'city-model',
    path: '/model',
    icon: Map,
    iconActive: Map,
    label: 'City Model',
    tooltip: 'Road network, hospitals, stations and venues',
  },
  {
    id: 'dispatch',
    path: '/dispatch',
    icon: Route,
    iconActive: Route,
    label: 'Dispatch',
    tooltip: 'Place an incident and solve the response',
  },
  {
    id: 'provenance',
    path: '/provenance',
    icon: Database,
    iconActive: Database,
    label: 'Data & Provenance',
    tooltip: 'Where the data came from and what is estimated',
  },
];

/**
 * Helper function to add navigation item dynamically
 */
export const addNavigationItem = (item: NavigationItem) => {
  navigationConfig.push(item);
};

/**
 * Helper function to remove navigation item
 */
export const removeNavigationItem = (id: string) => {
  const index = navigationConfig.findIndex((item) => item.id === id);
  if (index > -1) {
    navigationConfig.splice(index, 1);
  }
};

/**
 * Helper function to update badge count
 */
export const updateNavigationBadge = (id: string, badge?: number) => {
  const item = navigationConfig.find((item) => item.id === id);
  if (item) {
    item.badge = badge;
  }
};
