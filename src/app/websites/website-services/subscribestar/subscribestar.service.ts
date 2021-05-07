import $ from 'jquery';
import { Injectable } from '@angular/core';
import { Website } from '../../decorators/website-decorator';
import {
  Submission,
  SubmissionFormData,
} from 'src/app/database/models/submission.model';
import { BaseWebsiteService } from '../base-website-service';
import {
  WebsiteStatus,
  LoginStatus,
  SubmissionPostData,
  PostResult,
} from '../../interfaces/website-service.interface';
import { SubscribestarSubmissionForm } from './components/subscribestar-submission-form/subscribestar-submission-form.component';
import { SubmissionType } from 'src/app/database/tables/submission.table';
import {
  fileAsFormDataObject,
  MBtoBytes,
} from 'src/app/utils/helpers/file.helper';
import {
  TypeOfSubmission,
  getTypeOfSubmission,
} from 'src/app/utils/enums/type-of-submission.enum';
import { v1 as uuidv1 } from 'uuid';
import { Folder } from '../../interfaces/folder.interface';
import { BrowserWindowHelper } from 'src/app/utils/helpers/browser-window.helper';
import * as dotProp from 'dot-prop';

function submissionValidate(
  submission: Submission,
  formData: SubmissionFormData
): any[] {
  const problems: any[] = [];

  const options = dotProp.get(formData, `${Subscribestar.name}.options`, {});
  if (!options.ignoreFileSizeLimit) {
    let maxMB = 5;
    const type: TypeOfSubmission = getTypeOfSubmission(submission.fileInfo);
    if (type === TypeOfSubmission.ANIMATION) {
      maxMB = 250;
    } else if (type === TypeOfSubmission.STORY) {
      maxMB = 300;
    } else if (type === TypeOfSubmission.AUDIO) {
      maxMB = 50;
    }

    if (MBtoBytes(maxMB) < submission.fileInfo.size) {
      problems.push([
        'Max file size',
        { website: `SubscribeStar (${type})`, value: `${maxMB}MB` },
      ]);
    }
  }

  if (options.tiers && !options.tiers.length) {
    problems.push(['No tiers selected for SubscribeStar']);
  }

  return problems;
}

function descriptionParse(html: string): string {
  return html
    .replace(/<p/gm, '<div')
    .replace(/<\/p>/gm, '</div>')
    .replace(/\n/g, '');
}

@Injectable({
  providedIn: 'root',
})
@Website({
  additionalFiles: true,
  displayedName: 'SubscribeStar',
  login: {
    url: 'https://www.subscribestar.com',
  },
  components: {
    submissionForm: SubscribestarSubmissionForm,
    journalForm: SubscribestarSubmissionForm,
  },
  validators: {
    submission: submissionValidate,
  },
  parsers: {
    description: [descriptionParse],
    usernameShortcut: {
      code: 'ss',
      url: 'https://www.subscribestar.com/$1',
    },
  },
})
export class Subscribestar extends BaseWebsiteService {
  readonly BASE_URL: string = 'https://www.subscribestar.com';

  constructor() {
    super();
  }

  public async checkStatus(profileId: string): Promise<WebsiteStatus> {
    const returnValue: WebsiteStatus = {
      username: null,
      status: LoginStatus.LOGGED_OUT,
    };

    const cookies = await getCookies(profileId, this.BASE_URL);
    const response = await got.get(
      this.BASE_URL,
      this.BASE_URL,
      cookies,
      profileId
    );
    try {
      if (response.body.includes('top_bar-user_name')) {
        returnValue.username = response.body.match(
          /<div class="top_bar-user_name">(.*?)<\/div>/
        )[1];
        returnValue.status = LoginStatus.LOGGED_IN;
        await this.getTiers(profileId, cookies);
      }
    } catch (e) {
      /* No important error handling */
    }

    return returnValue;
  }

  private async getTiers(profileId: string, cookies: any[]) {
    const tiers: Folder[] = [
      {
        title: 'Public',
        id: 'free',
      },
    ];

    const body: string = await BrowserWindowHelper.runScript(
      profileId,
      `${this.BASE_URL}/profile/settings`,
      'document.body.innerHTML'
    );
    const matches = body.match(/<ol class="tiers for-settings">(.*?)<\/ol>/ms);
    const element = $.parseHTML(matches[0]);
    $(element)
      .find('.tiers-settings_item')
      .each(function () {
        tiers.push({
          title: $(this).find('.tiers-settings_item-title').text(),
          id: $(this).attr('data-id'),
        });
      });
    this.userInformation.set(profileId, { tiers });
  }

  getFolders(profileId: string) {
    return (this.userInformation.get(profileId) || {}).tiers || [];
  }

  public post(
    submission: Submission,
    postData: SubmissionPostData
  ): Promise<PostResult> {
    if (submission.submissionType === SubmissionType.SUBMISSION) {
      return this.postSubmission(submission, postData);
    } else if (submission.submissionType === SubmissionType.JOURNAL) {
      return this.postJournal(submission, postData);
    } else {
      throw new Error('Unknown submission type.');
    }
  }

  private async postJournal(
    submission: Submission,
    postData: SubmissionPostData
  ): Promise<PostResult> {
    const cookies = await getCookies(postData.profileId, this.BASE_URL);
    const response = await got.get(
      this.BASE_URL,
      this.BASE_URL,
      cookies,
      postData.profileId
    );

    const csrf = response.body.match(
      /<meta name="csrf-token" content="(.*?)"/
    )[1];
    const data = {
      utf8: '✓',
      html_content: `<div>${postData.options.useTitle ? `<h1>${postData.title}</h1>` : ''}${postData.description}</div>`,
      pinned_uploads: '[]',
      new_editor: 'true',
      is_draft: '',
      'tier_ids[]': (postData.options.tiers || []).includes('free') ? undefined : postData.options.tiers,
      'tags[]': postData.tags
    };

    const postResponse = await got.post(
      `${this.BASE_URL}/posts.json`,
      null,
      this.BASE_URL,
      cookies,
      {
        form: data,
        qsStringifyOptions: { arrayFormat: 'repeat' },
        headers: {
          Referer: 'https://www.subscribestar.com/',
          'X-CSRF-Token': csrf,
        },
      }
    );

    if (postResponse.error) {
      return Promise.reject(
        this.createPostResponse('Unknown error', postResponse.error)
      );
    }

    if (postResponse.success.response.statusCode === 200) {
      return this.createPostResponse(null);
    } else {
      return Promise.reject(
        this.createPostResponse('Unknown error', postResponse.success.body)
      );
    }
  }

  private getImageSize(
    buffer: Buffer,
    type: string
  ): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = `data:${type};base64,${buffer.toString('base64')}`;
      img.onload = () => {
        resolve({ width: img.width, height: img.height });
      };
    });
  }

  private async postSubmission(
    submission: Submission,
    postData: SubmissionPostData
  ): Promise<PostResult> {
    const cookies = await getCookies(postData.profileId, this.BASE_URL);
    const page = await got.get(
      this.BASE_URL,
      this.BASE_URL,
      cookies,
      postData.profileId
    );

    const response = await got.get(
      `${this.BASE_URL}${
        page.body.match(/class="top_bar-branding">(.*?)href="(.*?)"/ims)[2]
      }`,
      this.BASE_URL,
      cookies,
      postData.profileId
    );
    const body = response.body.replace(/\&quot;/g, '"');
    const csrf = response.body.match(
      /<meta name="csrf-token" content="(.*?)"/
    )[1];

    const files = [postData.primary, ...postData.additionalFiles]
      .filter((f) => f)
      .map((f) => fileAsFormDataObject(f));


    const uploadPath = (body.match(/data-s3-upload-path=\\"(.*?)\\"/) || [])[1];
    const bucket = (body.match(/data-s3-bucket="(.*?)"/) || [])[1];
    if (!uploadPath || !bucket) {
      return Promise.reject(
        this.createPostResponse('Issue getting upload data', body)
      );
    }

    let processData = undefined;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const key = `${uploadPath}/${uuidv1()}.${file.options.filename
        .split('.')
        .pop()}`;
      const presignUrl = `${this.BASE_URL}/presigned_url/upload?_=${Date.now()}&key=${encodeURIComponent(key)}&file_name=${encodeURIComponent(file.options.filename)}&content_type=${encodeURIComponent(file.options.contentType)}&bucket=${bucket}`;
      const presign = await got.get(presignUrl, this.BASE_URL, cookies, postData.profileId);

      let presignData = null;
      try {
        presignData = JSON.parse(presign.body);
      } catch {
        return Promise.reject(
          this.createPostResponse('Failed to upload file', presign.body)
        );
      }
 
      const postFile = await got.post(
        presignData.url,
        {
         ...presignData.fields,
          file,
          authenticity_token: csrf,
        },
        this.BASE_URL,
        cookies,
        {
          headers: {
            Referer: 'https://www.subscribestar.com/',
            Origin: 'https://www.subscribestar.com',
          },
        }
      );

      if (postFile.error) {
        return Promise.reject(
          this.createPostResponse('Failed to upload file', postFile.error)
        );
      }

      if (postFile.success && postFile.success.response.statusCode >= 200 && postFile.success.response.statusCode <= 300) {
        const xml = $($.parseXML(postFile.success.body));
        const record: any = {
          path: key,
          url: `${presignData.url}/${key}`,
          original_filename: file.options.filename,
          content_type: file.options.contentType,
          bucket,
          authenticity_token: csrf,
        };

        if (record.content_type.includes('image')) {
          const { width, height } = await this.getImageSize(
            file.value,
            record.content_type
          );
          record.height = height;
          record.width = width;
        }

        const processResponse = await got.post(
          `${this.BASE_URL}/post_uploads/process_s3_attachments.json`,
          null,
          this.BASE_URL,
          cookies,
          {
            json: record,
            headers: {
              Referer: 'https://www.subscribestar.com/',
              Origin: 'https://www.subscribestar.com',
            },
          }
        );

        if (processResponse.error) {
          return Promise.reject(
            this.createPostResponse(
              'Failed to upload file',
              processResponse.error
            )
          );
        }

        if (
          !(
            processResponse.success &&
            processResponse.success.response.statusCode === 200
          )
        ) {
          return Promise.reject(
            this.createPostResponse(
              'Failed to upload file',
              processResponse.success.body
            )
          );
        }

        processData = processResponse.success.body;
      } else {
        return Promise.reject(
          this.createPostResponse(
            'Failed to upload file',
            postFile.success.body
          )
        );
      }
    }

    if (files.length > 1) {
      const order = processData.imgs_and_videos.sort((a, b) => a.id - b.id).map(record => record.id);
      const reorder = await got.post(
        `${this.BASE_URL}/post_uploads/reorder`,
        null,
        this.BASE_URL,
        cookies,
        {
          json: {
            authenticity_token: csrf,
            upload_ids: order
          },
          headers: {
            Referer: 'https://www.subscribestar.com/',
            Origin: 'https://www.subscribestar.com',
          },
        }
      );
    }

    const data = {
      utf8: '✓',
      html_content: `<div>${postData.options.useTitle ? `<h1>${postData.title}</h1>` : ''}${postData.description}</div>`,
      pinned_uploads: '[]',
      new_editor: 'true',
      is_draft: '',
      'tier_ids[]': (postData.options.tiers || []).includes('free') ? undefined : postData.options.tiers,
      'tags[]': postData.tags
    };

    const postResponse = await got.post(
      `${this.BASE_URL}/posts.json`,
      null,
      this.BASE_URL,
      cookies,
      {
        form: data,
        qsStringifyOptions: { arrayFormat: 'repeat' },
        headers: {
          Referer: 'https://www.subscribestar.com/',
          'X-CSRF-Token': csrf,
        },
      }
    );

    if (postResponse.error) {
      return Promise.reject(
        this.createPostResponse('Unknown error', postResponse.error)
      );
    }

    if (postResponse.success.response.statusCode === 200) {
      return this.createPostResponse(null);
    } else {
      return Promise.reject(
        this.createPostResponse('Unknown error', postResponse.success.body)
      );
    }
  }
}
