import { KikoeruBridge } from '../infrastructure/KikoeruBridge';

export const getAxios = () => {
    return KikoeruBridge.getInstance().axios;
};
