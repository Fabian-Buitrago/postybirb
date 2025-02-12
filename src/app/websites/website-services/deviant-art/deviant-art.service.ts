import { Injectable } from '@angular/core';
import { Website } from '../../decorators/website-decorator';
import { DeviantArtLoginDialog } from './components/deviant-art-login-dialog/deviant-art-login-dialog.component';
import { GenericJournalSubmissionForm } from '../../components/generic-journal-submission-form/generic-journal-submission-form.component';
import { supportsFileType } from '../../helpers/website-validator.helper';
import { SubmissionRating, SubmissionType } from 'src/app/database/tables/submission.table';
import { SubmissionFormData, Submission } from 'src/app/database/models/submission.model';
import { BaseWebsiteService } from '../base-website-service';
import { LoginProfileManagerService } from 'src/app/login/services/login-profile-manager.service';
import { WebsiteStatus, LoginStatus, SubmissionPostData, PostResult, WebsiteService } from '../../interfaces/website-service.interface';
import { MBtoBytes, fileAsFormDataObject } from 'src/app/utils/helpers/file.helper';
import { TypeOfSubmission, getTypeOfSubmission } from 'src/app/utils/enums/type-of-submission.enum';
import { Folder } from '../../interfaces/folder.interface';
import { DeviantArtSubmissionForm } from './components/deviant-art-submission-form/deviant-art-submission-form.component';
import { UsernameParser } from 'src/app/utils/helpers/description-parsers/username.parser';

const ACCEPTED_FILES = ['jpeg', 'jpg', 'png', 'bmp', 'flv', 'txt', 'rtf', 'odt', 'swf', 'tiff', 'tif'];

function submissionValidate(submission: Submission, formData: SubmissionFormData): any[] {
  const problems: any[] = [];
  const rating = (formData[DeviantArt.name] || {}).rating || submission.rating;
  if (rating && (rating === SubmissionRating.ADULT || rating === SubmissionRating.EXTREME)) {
    problems.push(['Does not support rating', { website: 'DeviantArt', value: rating }]);
  }

  if (!supportsFileType(submission.fileInfo, ACCEPTED_FILES)) {
    problems.push(['Does not support file format', { website: 'DeviantArt', value: submission.fileInfo.type }]);
  }

  const type: TypeOfSubmission = getTypeOfSubmission(submission.fileInfo);
  let maxSize: number = 30;
  if (type === TypeOfSubmission.ANIMATION) maxSize = 200;
  if (MBtoBytes(maxSize) < submission.fileInfo.size) {
    problems.push(['Max file size', { website: `DeviantArt [${type}]`, value: `${maxSize}MB` }]);
  }

  return problems;
}

function preparser(html: string): string {
  return UsernameParser.replaceText(html, 'da', ':icon$1::dev$1:');
}

function descriptionParse(html: string): string {
  html = html
    .replace(/style="text-align:center;"/g, 'align="center"')
    .replace(/style="text-align:right;"/g, 'align="right"');

  html = UsernameParser.replaceText(html, 'da', ':icon$1::dev$1:');
  return html
    .replace(/<p/gm, '<div')
    .replace(/<\/p>/gm, '</div>')
    .replace(/\n/g, '');
}

interface DeviantArtFolder {
  description: string;
  folderid: string;
  has_subfolders: boolean;
  name: string;
  parent?: string;
  subfolders: DeviantArtFolder[];
}

@Injectable({
  providedIn: 'root'
})
@Website({
  acceptedFiles: ACCEPTED_FILES,
  refreshInterval: 5 * 60000,
  refreshBeforePost: true,
  login: {
    dialog: DeviantArtLoginDialog,
    url: 'https://www.deviantart.com/users/login'
  },
  components: {
    submissionForm: DeviantArtSubmissionForm,
    journalForm: GenericJournalSubmissionForm
  },
  validators: {
    submission: submissionValidate
  },
  preparsers: {
    description: [preparser]
  },
  parsers: {
    description: [descriptionParse],
    usernameShortcut: {
      code: 'da',
      url: 'https://deviantart.com/$1'
    }
  }
})
export class DeviantArt extends BaseWebsiteService implements WebsiteService {
  readonly BASE_URL: string = 'https://www.deviantart.com';

  constructor(private _profileManager: LoginProfileManagerService) {
    super();
  }

  public async checkStatus(profileId: string, data?: any): Promise<WebsiteStatus> {
    const returnValue: WebsiteStatus = {
      username: null,
      status: LoginStatus.LOGGED_OUT
    };

    if (data) {
      const refresh = await auth.deviantart.refresh(data);
      if (refresh) {
        returnValue.status = LoginStatus.LOGGED_IN;
        returnValue.username = refresh.username;
        this._profileManager.storeData(profileId, 'DeviantArt', refresh);
        await this._getFolders(profileId, refresh.access_token);
      } else {
        this.unauthorize(profileId);
      }
    } else {
      this.unauthorize(profileId);
    }

    return returnValue;
  }

  public async refreshTokens(profileId: string, data?: any): Promise<WebsiteStatus> {
    const returnValue: WebsiteStatus = {
      username: null,
      status: LoginStatus.LOGGED_OUT
    };

    if (data) {
      const refresh = await auth.deviantart.refresh(data, true);
      if (refresh) {
        returnValue.status = LoginStatus.LOGGED_IN;
        returnValue.username = refresh.username;
        this._profileManager.storeData(profileId, 'DeviantArt', refresh);
        await this._getFolders(profileId, refresh.access_token);
      } else {
        this.unauthorize(profileId);
      }
    } else {
      this.unauthorize(profileId);
    }

    return returnValue;
  }

  public unauthorize(profileId: string): void {
    this._profileManager.storeData(profileId, DeviantArt.name, null);
    const cookieSession = getCookieAPI(profileId);
    cookieSession.get({
      url: 'https://www.deviantart.com'
    }, (err, cookies) => {
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        cookieSession.remove('https://www.deviantart.com', cookie.name, (err) => {
          if (err) console.error(err);
        });
      }
    });
  }

  private flattenFolders(folder: DeviantArtFolder): DeviantArtFolder[] {
    const folders = [folder];

    if (!folder) {
      return [];
    }

    if (!folder.has_subfolders) {
      return folders;
    }

    folder.subfolders.forEach(sf => folders.push(...this.flattenFolders(sf)))
    return folders;
  }

  private async _getFolders(profileId: string, accessToken: string): Promise<void> {
    const folderResponse = await got.get(`${this.BASE_URL}/api/v1/oauth2/gallery/folders?calculate_size=false&limit=50&access_token=${accessToken}`, this.BASE_URL, [], profileId);
    const results = (JSON.parse(folderResponse.body).results || []);
    const folders: Folder[] = [];

    const flattenedFolders: DeviantArtFolder[] = [];
    results.forEach((r: DeviantArtFolder) => flattenedFolders.push(...this.flattenFolders(r)));

    flattenedFolders.forEach(folder => {
      const parent = folder.parent ? flattenedFolders.find(f => f.folderid === folder.parent && f.name !== 'Featured') : undefined;
      folders.push({
        id: folder.folderid,
        title: parent ? `${parent.name} / ${folder.name}` : folder.name,
      });
    });

    this.userInformation.set(profileId, { folders });
  }

  public getFolders(profileId: string): Folder[] {
    const info = this.userInformation.get(profileId) || {};
    return info.folders || [];
  }

  public post(submission: Submission, postData: SubmissionPostData): Promise<PostResult> {
    if (submission.submissionType === SubmissionType.SUBMISSION) {
      return this.postSubmission(submission, postData);
    } else if (submission.submissionType === SubmissionType.JOURNAL) {
      return this.postJournal(submission, postData);
    } else {
      throw new Error('Unknown submission type.');
    }
  }

  private async postJournal(submission: Submission, postData: SubmissionPostData): Promise<PostResult> {
    const authData = this._profileManager.getData(postData.profileId, DeviantArt.name);
    const data: any = {
      body: postData.description,
      access_token: authData.access_token
    };

    const postResponse = await got.post(`${this.BASE_URL}/api/v1/oauth2/user/statuses/post`, data, this.BASE_URL, null);

    if (postResponse.error) {
      return Promise.reject(this.createPostResponse('Unknown error', postResponse.error));
    }

    if (postResponse.success.response.statusCode === 200) {
      return this.createPostResponse(null);
    } else {
      const body = JSON.parse(postResponse.success.body);
      return Promise.reject(this.createPostResponse(body.error_description, postResponse.success.body));
    }
  }

  private async postSubmission(submission: Submission, postData: SubmissionPostData): Promise<PostResult> {
    const authData = this._profileManager.getData(postData.profileId, DeviantArt.name);
    const data: any = {
      title: postData.title,
      access_token: authData.access_token,
      file: fileAsFormDataObject(postData.primary),
      artist_comments: postData.description
    };

    const tags = this.formatTags(postData.tags, []);
    for (let i = 0; i < tags.length; i++) {
      data[`tags[${i}]`] = tags[i];
    }

    const upload = await got.post(`${this.BASE_URL}/api/v1/oauth2/stash/submit`, data, this.BASE_URL, []);
    if (upload.error) {
      return Promise.reject(this.createPostResponse('Unknown error', upload.error))
    }

    if (upload.success.response.statusCode !== 200) {
      const body = JSON.parse(upload.success.body);
      return Promise.reject(this.createPostResponse(body.error_description || 'Unknown error', upload.success.body));
    }

    const res = JSON.parse(upload.success.body);
    const submitData: any = {
      access_token: authData.access_token,
      itemid: res.itemid,
      agree_tos: '1',
      agree_submission: '1',
      is_mature: postData.rating !== SubmissionRating.GENERAL ? 'true' : 'false',
      display_resolution: '0',
    };

    if (postData.rating !== SubmissionRating.GENERAL) {
      submitData.mature_level = 'moderate';
    }

    const options = postData.options;

    if (options.matureLevel || options.matureClassification.length) {
      submitData.mature_level = options.matureLevel || 'moderate';
      submitData.is_mature = 'true';
    }

    if (options.matureClassification.length > 0) {
      for (let i = 0; i < options.matureClassification.length; i++) {
        const opt = options.matureClassification[i];
        submitData[`mature_classification[${i}]`] = opt;
      }
    }

    if (options.disableComments) submitData.allow_comments = 'no';
    if (options.critique) submitData.request_critique = 'yes';
    if (options.freeDownload) submitData.allow_free_download = 'no';
    submitData.feature = options.feature ? 'yes' : 'no';
    if (options.displayResolution) submitData.display_resolution = options.displayResolution;

    if ((options.folders || []).length > 0) {
      for (let i = 0; i < options.folders.length; i++) {
        submitData[`galleryids[${i}]`] = options.folders[i];
      }
    }

    const postResponse = await got.post(`${this.BASE_URL}/api/v1/oauth2/stash/publish`, submitData, this.BASE_URL, []);
    if (postResponse.error) {
      return Promise.reject(this.createPostResponse('Unknown error', postResponse.error));
    }

    const json = JSON.parse(postResponse.success.body);
    if (postResponse.success.response.statusCode === 200) {
      const res = this.createPostResponse(null);
      res.srcURL = json.url;
      return res;
    } else {
      return Promise.reject(this.createPostResponse(json.error_description || 'Unknown error', postResponse.success.body));
    }
  }
}
