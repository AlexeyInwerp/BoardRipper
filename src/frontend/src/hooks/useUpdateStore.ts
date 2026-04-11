import { createStoreHook } from './createStoreHook';
import { updateStore } from '../store/update-store';

export const useUpdateStore = createStoreHook(updateStore, () => ({
  state: { ...updateStore.state },
  updating: updateStore.updating,
  progress: [...updateStore.progress],
}));
