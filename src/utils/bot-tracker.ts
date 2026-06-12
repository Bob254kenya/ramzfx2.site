let activeBot: { source: string; id: string; name: string } | null = null;

export const setActiveBot = (source: string, id: string, name: string) => {
    activeBot = { source, id, name };
};

export const getActiveBot = () => activeBot;

export const clearActiveBot = () => {
    activeBot = null;
};
