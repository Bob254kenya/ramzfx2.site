import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSass } from '@rsbuild/plugin-sass';

const path = require('path');

export default defineConfig({
    plugins: [
        pluginSass({
            sassLoaderOptions: {
                sourceMap: true,
                sassOptions: {},
            },
            exclude: /node_modules/,
        }),
        pluginReact(),
    ],
    source: {
        entry: {
            index: './src/main.tsx',
        },
        define: {
            'process.env': {
                APP_ENV: JSON.stringify(process.env.APP_ENV || 'production'),
                CLIENT_ID: JSON.stringify(process.env.CLIENT_ID),
                APP_ID: JSON.stringify(process.env.APP_ID),
                REDIRECT_URI: JSON.stringify(process.env.REDIRECT_URI || ''),
                GD_CLIENT_ID: JSON.stringify(process.env.GD_CLIENT_ID),
                GD_APP_ID: JSON.stringify(process.env.GD_APP_ID),
                GD_API_KEY: JSON.stringify(process.env.GD_API_KEY),
                API_BASE_URL: JSON.stringify(process.env.API_BASE_URL || process.env.VITE_API_BASE_URL || '/api'),
            },
        },
    },
    resolve: {
        alias: {
            react: path.resolve('./node_modules/react'),
            'react-dom': path.resolve('./node_modules/react-dom'),
            '@/external': path.resolve(__dirname, './src/external'),
            '@/components': path.resolve(__dirname, './src/components'),
            '@/hooks': path.resolve(__dirname, './src/hooks'),
            '@/utils': path.resolve(__dirname, './src/utils'),
            '@/constants': path.resolve(__dirname, './src/constants'),
            '@/stores': path.resolve(__dirname, './src/stores'),
        },
    },
    output: {
        copy: [
            {
                from: 'node_modules/@deriv-com/smartcharts-champion/dist/*',
                to: 'js/smartcharts/[name][ext]',
                globOptions: {
                    ignore: ['**/*.LICENSE.txt'],
                },
            },
            { from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/*', to: 'assets/[name][ext]' },
            {
                from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/fonts/*',
                to: 'assets/fonts/[name][ext]',
            },
            {
                from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/shaders/*',
                to: 'assets/shaders/[name][ext]',
            },
            { from: path.join(__dirname, 'public') },
        ],
    },
    html: {
        template: './index.html',
    },
    server: {
        port: 5000,
        host: '0.0.0.0',
        compress: true,
        proxy: {
            '/api': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
        },
    },
    dev: {
        hmr: true,
        lazyCompilation: false,
        client: {
            host: process.env.REPLIT_DEV_DOMAIN || 'localhost',
            port: 443,
            protocol: 'wss',
        },
    },
    performance: {
        bundleAnalyze:
            process.env.BUNDLE_ANALYZE === 'true'
                ? {
                      analyzerMode: 'server',
                      analyzerHost: 'localhost',
                      analyzerPort: 8888,
                      openAnalyzer: true,
                      generateStatsFile: true,
                      statsFilename: 'stats.json',
                  }
                : undefined,
    },
    tools: {
        rspack: {
            plugins: [],
            module: {
                rules: [
                    {
                        test: /\.xml$/,
                        exclude: /node_modules/,
                        type: 'asset/source',
                    },
                ],
            },
        },
    },
});
