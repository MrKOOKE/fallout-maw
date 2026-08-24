const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const RemoveEmptyScriptsPlugin = require('webpack-remove-empty-scripts');
const TerserPlugin = require("terser-webpack-plugin");
const CircularDependencyPlugin = require('circular-dependency-plugin');
const fs = require('fs');

/**
 * Generates all the entry points needed.
 * @returns {{index: string, "styles/calendar": string}}
 */
function getEntries() {
    //Default required entry points
    const list = {
        "index": {import: './src/index.ts'},
        "styles/calendar": './src/styles/index.scss'
    };

    //Get all the additional theme files as entry points
    fs.readdirSync('./src/styles/themes/').forEach((file) => {
         if(file.endsWith('.scss') && !file.startsWith('_')){
             list[`styles/themes/${file.replace('.scss', '')}`] = `./src/styles/themes/${file}`;
         }
    });
    return list;
}

module.exports = {
    entry: getEntries(),
    optimization: {
        removeEmptyChunks: true,
        minimize: true,
        minimizer: [new TerserPlugin({
            extractComments: false, // To avoid separate file with licenses.
            terserOptions: {
                ecma: '2020',
                mangle: true,
                sourceMap: false,
                module: true,
                keep_classnames: /^(NoteSheet|MainApp)$/,
                keep_fnames: false,
                toplevel: true,
            },
        })]
    },
    plugins: [
        new CircularDependencyPlugin({
            exclude: /__mocks__|docs|dist|node_modules|\.test\.ts/,
            include: /src/,
            failOnError: true,
        }),
        new CopyPlugin({
            patterns: [
                { context: './src/', from : '**/*.json', to : './', globOptions: {ignore: ['**/module.json', '**/lang/**']} },
                { context: './src/lang/', from : 'en.json', to : './lang/' },
                { context: './src/lang/', from : 'ru.json', to : './lang/' },
                { context: './src/', from : '**/*.(hbs|html)', to : '[path][name].html' },
                { context: './', from : 'LICENSE', to : './' },
                { context: './', from : 'THIRD_PARTY_NOTICES.md', to : './' },
                { context: './src/assets', from: '**/*.png', to: './assets/'}
            ]
        }),
        new RemoveEmptyScriptsPlugin(),
        new MiniCssExtractPlugin({
            filename: "[name].css"
        })
    ],
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: {
                    loader: 'ts-loader',
                    options: { onlyCompileBundledFiles: true }
                },
                exclude: [/node_modules/, /\.test\.ts$/],
            },
            {
                test: /\.s[ac]ss$/i,
                use: [
                    MiniCssExtractPlugin.loader,
                    // Translates CSS into CommonJS
                    {
                        loader: 'css-loader',
                        options: {
                            url: { filter: (url, resourcePath) => {return !(url.indexOf('/ui/') > -1);}}
                        }
                    },
                    // Compiles Sass to CSS
                    'sass-loader'
                ],
            },
            {
                test: /\.svg$/,
                type: 'asset/source'
            },
        ]
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    performance: {
        maxEntrypointSize: 512000,
        maxAssetSize: 512000
    },
    output: {
        path: path.resolve(__dirname, '../calendar'),
        filename: '[name].js',
        clean: true
    },
};
