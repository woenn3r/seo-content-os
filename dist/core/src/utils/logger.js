export const logger = {
    info(event, payload) {
        if (payload) {
            console.log(`[INFO] ${event}`, payload);
            return;
        }
        console.log(`[INFO] ${event}`);
    },
    warn(event, payload) {
        if (payload) {
            console.warn(`[WARN] ${event}`, payload);
            return;
        }
        console.warn(`[WARN] ${event}`);
    },
    error(event, payload) {
        if (payload) {
            console.error(`[ERROR] ${event}`, payload);
            return;
        }
        console.error(`[ERROR] ${event}`);
    },
};
