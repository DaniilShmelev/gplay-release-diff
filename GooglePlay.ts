import * as fs from 'fs';
import * as path from 'path';
import * as tl from 'azure-pipelines-task-lib/task';
import * as glob from 'glob';
import * as apkReader from 'adbkit-apkreader';
import * as googleutil from './googleutil';
import { androidpublisher_v3 as pub3 } from 'googleapis';
import { JWT } from 'google-auth-library';

async function run() {
    try {
        tl.setResourcePath(path.join(__dirname, 'task.json'));

        tl.debug('Prepare task inputs.');

        const authType: string = tl.getInput('authType', true);
        let key: googleutil.ClientKey = {};
        if (authType === 'JsonFile') {
            const serviceAccountKeyFile: string = tl.getPathInput('serviceAccountKey', true, true);

            const stats: tl.FsStats = tl.stats(serviceAccountKeyFile);
            if (stats && stats.isFile()) {
                key = require(serviceAccountKeyFile);
            } else {
                tl.debug(`The service account file path ${serviceAccountKeyFile} points to a directory.`);
                throw new Error(tl.loc('InvalidAuthFile', serviceAccountKeyFile));
            }
        } else if (authType === 'ServiceEndpoint') {
            let serviceEndpoint: tl.EndpointAuthorization = tl.getEndpointAuthorization(tl.getInput('serviceEndpoint', true), false);
            key.client_email = serviceEndpoint.parameters['username'];
            key.private_key = serviceEndpoint.parameters['password'].replace(/\\n/g, '\n');
        }
        const mainApkPattern: string = tl.getPathInput('apkFile', true);
        tl.debug(`Main APK pattern: ${mainApkPattern}`);

        const mainApkFile: string = resolveGlobPath(mainApkPattern);
        tl.checkPath(mainApkFile, 'apkFile');
        const reader = await apkReader.open(mainApkFile);
        const manifest = await reader.readManifest();
        const mainVersionCode = manifest.versionCode;
        console.log(tl.loc('FoundMainApk', mainApkFile, mainVersionCode));
        tl.debug(`    Found the main APK file: ${mainApkFile} (version code ${mainVersionCode}).`);

        const apkFileList: string[] = await getAllApkPaths(mainApkFile);
        if (apkFileList.length > 1) {
            console.log(tl.loc('FoundMultiApks'));
            console.log(apkFileList);
        }

        const versionCodeFilterType: string = tl.getInput('versionCodeFilterType', false) ;
        let versionCodeFilter: string | number[] = null;
        if (versionCodeFilterType === 'list') {
            versionCodeFilter = getVersionCodeListInput();
        } else if (versionCodeFilterType === 'expression') {
            versionCodeFilter = tl.getInput('replaceExpression', true);
        }

        const track: string = tl.getInput('track', true);
        const userFractionSupplied: boolean = tl.getBoolInput('rolloutToUserFraction');
        const userFraction: number = Number(userFractionSupplied ? tl.getInput('userFraction', false) : 1.0);

        const updatePrioritySupplied: boolean = tl.getBoolInput('changeUpdatePriority');
        const updatePriority: number = Number(updatePrioritySupplied ? tl.getInput('updatePriority', false) : 0);

        const shouldAttachMetadata: boolean = tl.getBoolInput('shouldAttachMetadata', false);
        const updateStoreListing: boolean = tl.getBoolInput('updateStoreListing', false);
        const shouldUploadApks: boolean = tl.getBoolInput('shouldUploadApks', false);

        const shouldPickObbFile: boolean = tl.getBoolInput('shouldPickObbFile', false);
        const shouldPickObbFileForAdditonalApks: boolean = tl.getBoolInput('shouldPickObbFileForAdditonalApks', false);

        let changelogFile: string = null;
        let languageCode: string = null;
        let metadataRootPath: string = null;

        if (shouldAttachMetadata) {
            metadataRootPath = tl.getPathInput('metadataRootPath', true, true);
        } else {
            changelogFile = tl.getInput('changelogFile', false);
            languageCode = tl.getInput('languageCode', false) || 'en-US';
        }

        const globalParams: googleutil.GlobalParams = { auth: null, params: {} };
        const apkVersionCodes: number[] = [];

        // The submission process is composed
        // of a transaction with the following steps:
        // -----------------------------------------
        // #1) Extract the package name from the specified APK file
        // #2) Get an OAuth token by authenticating the service account
        // #3) Create a new editing transaction
        // #4) Upload the new APK(s)
        // #5) Specify the track that should be used for the new APK (e.g. alpha, beta)
        // #6) Specify the new change log
        // #7) Commit the edit transaction

        tl.debug(`Getting a package name from ${mainApkFile}`);
        const packageName: string = manifest.package;
        googleutil.updateGlobalParams(globalParams, 'packageName', packageName);

        tl.debug('Initializing JWT.');
        const jwtClient: JWT = googleutil.getJWT(key);
        globalParams.auth = jwtClient;

        tl.debug('Initializing Google Play publisher API.');
        const edits: pub3.Resource$Edits = googleutil.publisher.edits;

        tl.debug('Authorize JWT.');
        await jwtClient.authorize();

        console.log(tl.loc('GetNewEditAfterAuth'));
        tl.debug('Creating a new edit transaction in Google Play.');
        const edit = await googleutil.getNewEdit(edits, globalParams, packageName);
        googleutil.updateGlobalParams(globalParams, 'editId', edit.id);

        let requireTrackUpdate = false;

        if (updateStoreListing) {
            tl.debug('Selected store listing update -> skip APK reading');
        } else if (shouldUploadApks) {
            tl.debug(`Uploading ${apkFileList.length} APK(s).`);
            requireTrackUpdate = true;

            for (const apkFile of apkFileList) {
                tl.debug(`Uploading APK ${apkFile}`);
                const apk: googleutil.Apk = await googleutil.addApk(edits, packageName, apkFile);
                tl.debug(`Uploaded ${apkFile} with the version code ${apk.versionCode}`);
                if ((shouldPickObbForApk(apkFile, mainApkFile, shouldPickObbFile, shouldPickObbFileForAdditonalApks)) && (getObbFile(apkFile, packageName, apk.versionCode) !== null)) {
                    const obb: googleutil.ObbResponse = await googleutil.addObb(edits, packageName, getObbFile(apkFile, packageName, apk.versionCode), apk.versionCode, 'main');
                    if (obb.expansionFile.fileSize !== 0) {
                        console.log(`Uploaded Obb file with version code ${apk.versionCode} and size ${obb.expansionFile.fileSize}`);
                    }
                }
                apkVersionCodes.push(apk.versionCode);
            }

            if (apkVersionCodes.length > 0 && tl.getBoolInput('shouldUploadMappingFile', false)) {
                const mappingFilePattern = tl.getPathInput('mappingFilePath', false);
                tl.debug(`Mapping file pattern: ${mappingFilePattern}`);

                const mappingFilePath = resolveGlobPath(mappingFilePattern);
                tl.checkPath(mappingFilePath, 'mappingFilePath');
                console.log(tl.loc('FoundDeobfuscationFile', mappingFilePath));
                tl.debug(`Uploading mapping file ${mappingFilePath}`);
                await googleutil.uploadDeobfuscation(edits, mappingFilePath, packageName, apkVersionCodes[0]);
                tl.debug(`Uploaded ${mappingFilePath} for APK ${mainApkFile}`);
            }
        } else {
            tl.debug(`Getting APK version codes of ${apkFileList.length} APK(s).`);

            for (let apkFile of apkFileList) {
                tl.debug(`Getting version code of APK ${apkFile}`);
                const reader = await apkReader.open(apkFile);
                const manifest = await reader.readManifest();
                const apkVersionCode: number = manifest.versionCode;
                tl.debug(`Got APK ${apkFile} version code: ${apkVersionCode}`);
                apkVersionCodes.push(apkVersionCode);
            }
        }

        let releaseNotes: googleutil.ReleaseNotes[];
        if (shouldAttachMetadata) {
            console.log(tl.loc('AttachingMetadataToRelease'));
            tl.debug(`Uploading metadata from ${metadataRootPath}`);
            releaseNotes = await addMetadata(edits, apkVersionCodes, metadataRootPath);
            if (updateStoreListing) {
                tl.debug('Selected store listing update -> skip update track');
            }
            requireTrackUpdate = !updateStoreListing;
        } else if (changelogFile) {
            tl.debug(`Uploading the common change log ${changelogFile} to all versions`);
            const commonNotes = await getCommonReleaseNotes(languageCode, changelogFile);
            releaseNotes = commonNotes && [commonNotes];
            requireTrackUpdate = true;
        }

        if (requireTrackUpdate) {
            console.log(tl.loc('UpdateTrack'));
            tl.debug(`Updating the track ${track}.`);
            const updatedTrack: googleutil.Track = await updateTrack(edits, packageName, track, apkVersionCodes, versionCodeFilterType, versionCodeFilter, userFraction, updatePriority, releaseNotes);
            tl.debug('Updated track info: ' + JSON.stringify(updatedTrack));
        }

        tl.debug('Committing the edit transaction in Google Play.');
        await edits.commit();

        if (updateStoreListing) {
            console.log(tl.loc('StoreListUpdateSucceed'));
        } else {
            console.log(tl.loc('AptPublishSucceed'));
            console.log(tl.loc('TrackInfo', track));
        }

        tl.setResult(tl.TaskResult.Succeeded, tl.loc('Success'));
    } catch (e) {
        if (e) {
            tl.debug('Exception thrown releasing to Google Play: ' + e);
        } else {
            tl.debug('Unknown error, no response given from Google Play');
        }
        tl.setResult(tl.TaskResult.Failed, e);
    }
}

/**
 * Update a given release track with the given information
 * Assumes authorized
 * @param {string} packageName unique android package name (com.android.etc)
 * @param {string} track one of the values {"internal", "alpha", "beta", "production"}
 * @param {number[]} apkVersionCodes version code of uploaded modules.
 * @param {string} versionCodeListType type of version code replacement filter, i.e. 'all', 'list', or 'expression'
 * @param {string | string[]} versionCodeFilter version code filter, i.e. either a list of version code or a regular expression string.
 * @param {double} userFraction the fraction of users to get update
 * @param {priority} updatePriority - In-app update priority value of the release. All newly added APKs in the release will be considered at this priority. Can take values in the range [0, 5], with 5 the highest priority. Defaults to 0.
 * @param {googleutil.ReleaseNotes[]} releaseNotes optional release notes to be attached as part of the update
 * @returns {Promise} track A promise that will return result from updating a track
 *                            { track: string, versionCodes: [integer], userFraction: double }
 */
async function updateTrack(
    edits: pub3.Resource$Edits,
    packageName: string,
    track: string,
    apkVersionCodes: number[],
    versionCodeListType: string,
    versionCodeFilter: string | number[],
    userFraction: number,
    updatePriority: number,
    releaseNotes?: googleutil.ReleaseNotes[]): Promise<googleutil.Track> {

    let newTrackVersionCodes: number[] = [];
    let res: googleutil.Track;

    if (versionCodeListType === 'all') {
        newTrackVersionCodes = apkVersionCodes;
    } else {
        try {
            res = await googleutil.getTrack(edits, packageName, track);
        } catch (e) {
            tl.debug(`Failed to download track ${track} information.`);
            tl.debug(e);
            throw new Error(tl.loc('CannotDownloadTrack', track, e));
        }

        const oldTrackVersionCodes: number[] = res.releases[0].versionCodes;
        tl.debug('Current version codes: ' + JSON.stringify(oldTrackVersionCodes));

        if (typeof(versionCodeFilter) === 'string') {
            tl.debug(`Removing version codes matching the regular expression: ^${versionCodeFilter as string}$`);
            const versionCodesToRemove: RegExp = new RegExp(`^${versionCodeFilter as string}$`);

            oldTrackVersionCodes.forEach((versionCode) => {
                if (!versionCode.toString().match(versionCodesToRemove)) {
                    newTrackVersionCodes.push(versionCode);
                }
            });
        } else {
            const versionCodesToRemove: number[] = versionCodeFilter as number[];
            tl.debug('Removing version codes: ' + JSON.stringify(versionCodesToRemove));

            oldTrackVersionCodes.forEach((versionCode) => {
                if (versionCodesToRemove.indexOf(versionCode) === -1) {
                    newTrackVersionCodes.push(versionCode);
                }
            });
        }

        tl.debug('Version codes to keep: ' + JSON.stringify(newTrackVersionCodes));
        apkVersionCodes.forEach((versionCode) => {
            if (newTrackVersionCodes.indexOf(versionCode) === -1) {
                newTrackVersionCodes.push(versionCode);
            }
        });
    }

    tl.debug(`New ${track} track version codes: ` + JSON.stringify(newTrackVersionCodes));
    try {
        res = await googleutil.updateTrack(edits, packageName, track, newTrackVersionCodes, userFraction, updatePriority, releaseNotes);
    } catch (e) {
        tl.debug(`Failed to update track ${track}.`);
        tl.debug(e);
        throw new Error(tl.loc('CannotUpdateTrack', track, e));
    }
    return res;
}

/**
 * Get the appropriate file from the provided pattern
 * @param {string} path The minimatch pattern of glob to be resolved to file path
 * @returns {string} path path of the file resolved by glob
 */
function resolveGlobPath(path: string): string {
    if (path) {
        // VSTS tries to be smart when passing in paths with spaces in them by quoting the whole path. Unfortunately, this actually breaks everything, so remove them here.
        path = path.replace(/\"/g, '');

        const filesList: string[] = glob.sync(path);
        if (filesList.length > 0) {
            path = filesList[0];
        }
    }

    return path;
}

/**
 * Get the appropriate files from the provided pattern
 * @param {string} path The minimatch pattern of glob to be resolved to file path
 * @returns {string[]} paths of the files resolved by glob
 */
function resolveGlobPaths(path: string): string[] {
    if (path) {
        // Convert the path pattern to a rooted one. We do this to mimic for string inputs the behaviour of filePath inputs provided by Build Agent.
        path = tl.resolve(tl.getVariable('System.DefaultWorkingDirectory'), path);

        let filesList: string[] = glob.sync(path);
        if (filesList.length === 0) {
            filesList.push(path);
        }
        tl.debug(`Additional APK paths: ${JSON.stringify(filesList)}`);

        return filesList;
    }

    return [];
}

/**
 * Get obb file. Returns any file with .obb extension if present in parent directory else returns
 * from apk directory with pattern: main.<versionCode>.<packageName>.obb
 * @param {string} apkPath apk file path
 * @param {string} packageName package name of the apk
 * @param {string} versionCode version code of the apk
 * @returns {string} ObbPathFile of the obb file if present else null
 */
function getObbFile(apkPath: string, packageName: string, versionCode: number): string {
    const currentDirectory: string = path.dirname(apkPath);
    const parentDirectory: string = path.dirname(currentDirectory);

    const fileNamesInParentDirectory: string[] = fs.readdirSync(parentDirectory);
    const obbPathFileInParent: string | undefined = fileNamesInParentDirectory.find(file => path.extname(file) === '.obb');

    if (obbPathFileInParent) {
        tl.debug(`Found Obb file for upload in parent directory: ${obbPathFileInParent}`);
        return path.join(parentDirectory, obbPathFileInParent);
    }

    const fileNamesInApkDirectory: string[] = fs.readdirSync(currentDirectory);
    const expectedMainObbFile: string = `main.${versionCode}.${packageName}.obb`;
    const obbPathFileInCurrent: string | undefined = fileNamesInApkDirectory.find(file => file.toString() === expectedMainObbFile);

    if (obbPathFileInCurrent) {
        tl.debug(`Found Obb file for upload in current directory: ${obbPathFileInCurrent}`);
        return path.join(currentDirectory, obbPathFileInCurrent);
    } else {
        tl.debug(`No Obb found for ${apkPath}, skipping upload`);
    }

    return obbPathFileInCurrent;
}

/**
 * Get unique APK file paths from main and additional APK file inputs.
 * @returns {string[]} paths of the files
 */
async function getAllApkPaths(mainApkFile: string): Promise<string[]> {
    const apkFileList: { [key: string]: number } = {};

    apkFileList[mainApkFile] = 0;

    const additionalApks: string[] = tl.getDelimitedInput('additionalApks', '\n');
    for (const additionalApk of additionalApks) {
        tl.debug(`Additional APK pattern: ${additionalApk}`);
        const apkPaths: string[] = resolveGlobPaths(additionalApk);

        for (const apkPath of apkPaths) {
            apkFileList[apkPath] = 0;
            tl.debug(`Checking additional APK ${apkPath} version...`);
            const reader = await apkReader.open(apkPath);
            const manifest = await reader.readManifest();
            tl.debug(`    Found the additional APK file: ${apkPath} (version code ${manifest.versionCode}).`);
        }
    }

    return Object.keys(apkFileList);
}

function getVersionCodeListInput(): number[] {
    const versionCodeFilterInput: string[] = tl.getDelimitedInput('replaceList', ',', false);
    const versionCodeFilter: number[] = [];
    const incorrectCodes: string[] = [];

    for (const versionCode of versionCodeFilterInput) {
        const versionCodeNumber: number = parseInt(versionCode.trim(), 10);

        if (versionCodeNumber && (versionCodeNumber > 0)) {
            versionCodeFilter.push(versionCodeNumber);
        } else {
            incorrectCodes.push(versionCode.trim());
        }
    }

    if (incorrectCodes.length > 0) {
        throw new Error(tl.loc('IncorrectVersionCodeFilter', JSON.stringify(incorrectCodes)));
    } else {
        return versionCodeFilter;
    }
}

function shouldPickObbForApk(apk: string, mainApk: string, shouldPickObbFile: boolean, shouldPickObbFileForAdditonalApks: boolean): boolean {

    if ((apk === mainApk) && shouldPickObbFile) {
        return true;
    } else if ((apk !== mainApk) && shouldPickObbFileForAdditonalApks) {
        return true;
    }
    return false;
}

// Future features:
// ----------------
// 1) Adding testers
// 2) Adding new images
// 3) Adding expansion files
// 4) Updating contact info

run();
