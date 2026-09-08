import { FilterDropdown } from './FilterDropdown';
import type { SlotCtx } from '../slot-ctx';

/** Find net — see FilterDropdown for the shared implementation. */
export function NetsDropdown({ ctx }: { ctx: SlotCtx }) {
  return <FilterDropdown ctx={ctx} kind="nets" />;
}
