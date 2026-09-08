import { FilterDropdown } from './FilterDropdown';
import type { SlotCtx } from '../slot-ctx';

/** Find part — see FilterDropdown for the shared implementation. */
export function PartsDropdown({ ctx }: { ctx: SlotCtx }) {
  return <FilterDropdown ctx={ctx} kind="parts" />;
}
