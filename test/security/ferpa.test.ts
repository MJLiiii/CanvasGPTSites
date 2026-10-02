// Ports the anonymization cases of upstream tests/security/test_ferpa_compliance.py (TC-1.1) and adds end-to-end
// checks of the path gate plus scrubber. Passing these tests does not establish institutional FERPA compliance.
import { describe, expect, it } from 'vitest';

import { anonymizeResponse, anonymizeResponseData } from '../../src/core/anonymization';
import type { PseudonymOptions } from '../../src/core/anonymization';
import { maxTier, tierForPath } from '../../src/core/anonymization-tiers';
import type { AnonymizationTier } from '../../src/types';

type Json = any;

function fresh(salt: string | null = null): PseudonymOptions {
  return { salt, memo: new Map() };
}

/** What the Canvas client does with a response: tier from the final path, optionally raised, then scrub. */
function throughClient(data: Json, path: string, options: { forceTier?: AnonymizationTier; salt?: string | null } = {}): Json {
  const tier = maxTier(tierForPath(path), options.forceTier ?? 'none');
  return anonymizeResponse(data, { tier, path, ...fresh(options.salt ?? null) });
}

const ROSTER_PII = ['Jane Smith', 'Smith, Jane', 'jsmith7', 'jane.smith@university.edu', '650009876', 'she/her', '217-555-0199'];

function roster(): Json {
  return [
    {
      id: 54321,
      name: 'Jane Smith',
      sortable_name: 'Smith, Jane',
      short_name: 'Jane Smith',
      login_id: 'jsmith7',
      email: 'jane.smith@university.edu',
      sis_user_id: '650009876',
      pronouns: 'she/her',
      avatar_url: 'https://canvas.example.edu/images/jsmith7.png',
      bio: 'Call me at 217-555-0199',
      enrollments: [{ id: 1, user_id: 54321, type: 'StudentEnrollment', sis_user_id: '650009876' }],
    },
  ];
}

function expectNoRosterPii(payload: unknown): void {
  const blob = JSON.stringify(payload);
  for (const value of ROSTER_PII) {
    expect(blob, `PII leaked: ${value}`).not.toContain(value);
  }
}

describe('TC-1.1 PII anonymization', () => {
  it('TC-1.1.1 anonymizes student names and keeps the id', () => {
    const sample = { user: { name: 'John Doe', id: 12345, email: 'john.doe@example.com' } };
    const result = anonymizeResponseData(sample, 'test_endpoint', fresh());

    expect(result.user.name).not.toBe('John Doe');
    expect(result.user.name).toBe('Student_5994471a');
    // Id preserved for functionality.
    expect(result.user.id).toBe(12345);
  });

  it('TC-1.1.2 anonymizes student emails', () => {
    const sample = { user: { name: 'Jane Smith', id: 54321, email: 'jane.smith@university.edu' } };
    const result = anonymizeResponseData(sample, 'test_endpoint', fresh());

    expect(result.user.email).not.toBe('jane.smith@university.edu');
    expect(result.user.email).toBe('student_20f37658@example.edu');
  });

  it('TC-1.1.1 gives the same student the same pseudonym across calls', () => {
    const sample = { user: { name: 'Test Student', id: 99999 } };
    // Separate memos stand for separate requests: consistency comes from the
    // hash, not from shared state.
    const first = anonymizeResponseData({ ...sample }, 'test_endpoint', fresh());
    const second = anonymizeResponseData({ ...sample }, 'test_endpoint', fresh());

    expect(first.user.name).toBe(second.user.name);
    expect(first.user.name).toBe('Student_fd5f56b4');
  });

  it('gives the same student the same pseudonym across requests when salted, and a different one per salt', () => {
    const sample = { user: { name: 'Test Student', id: 99999 } };
    const first = anonymizeResponseData(sample, 'test_endpoint', fresh('pepper'));
    const second = anonymizeResponseData(sample, 'test_endpoint', fresh('pepper'));
    const other = anonymizeResponseData(sample, 'test_endpoint', fresh('a different salt'));

    expect(first.user.name).toBe('Student_815a061d');
    expect(second.user.name).toBe(first.user.name);
    expect(other.user.name).not.toBe(first.user.name);
    // The unsalted pseudonym can be recomputed from the id by anyone.
    expect(first.user.name).not.toBe('Student_fd5f56b4');
  });
});

describe('student records never reach the model with real identity', () => {
  it.each([
    '/courses/1/users',
    '/courses/1/users/54321',
    '/courses/1/enrollments',
    '/sections/9/enrollments',
    '/groups/4/users',
    '/courses/1/analytics/student_summaries',
    '/courses/1/assignments/2/submissions',
    '/users/54321/profile',
    '/users/self/observees',
    '/users/self/enrollments',
    '/api/quiz/v1/courses/1/users',
  ])('a roster served from %s is scrubbed', (path) => {
    const result = throughClient(roster(), path);
    expectNoRosterPii(result);
    expect(result[0].id).toBe(54321);
    expect(result[0].name).toBe('Student_20f37658');
    expect(result[0].email).toBe('student_20f37658@example.edu');
    expect(result[0].enrollments[0].type).toBe('StudentEnrollment');
  });

  it.each(['/courses/1/%75sers', '/courses/1/USERS', '/courses/1/users/', '/courses/1/users?per_page=100'])(
    'spelling the path as %s does not bypass the gate',
    (path) => {
      expectNoRosterPii(throughClient(roster(), path));
    },
  );

  it('a page slug cannot pull a roster through the page tier', () => {
    // The tier comes from the final pathname, not the template the tool
    // wrote, so whatever a slug resolves to is classified as what it is.
    expect(tierForPath('/courses/1/assignments/2/submissions/456')).toBe('full');
    expect(tierForPath('/courses/1/pages/x/users')).toBe('full');
  });

  it('display names embedded in an ungated listing are scrubbed when the caller forces the tier', () => {
    // /courses/{id}/groups is not gated by path, and the gate cannot see
    // include[]=users. A tool that asks for members must raise the tier itself.
    const groups = [{ id: 7, name: 'Team A', members_count: 1, users: roster() }];
    expect(tierForPath('/courses/1/groups')).toBe('none');

    const result = throughClient(groups, '/courses/1/groups', { forceTier: 'full' });
    expectNoRosterPii(result);
    expect(result[0].name).toBe('Team A');
    expect(result[0].users[0].name).toBe('Student_20f37658');
  });

  it('a forced tier can raise but never lower the path’s tier', () => {
    for (const forceTier of ['none', 'identity', 'free_text', 'full'] as const) {
      expectNoRosterPii(throughClient(roster(), '/courses/1/users', { forceTier }));
    }
  });

  it('the salted form leaks neither identity nor the brute-forceable unsalted hash', () => {
    const result = throughClient(roster(), '/courses/1/users', { salt: 'pepper' });
    expectNoRosterPii(result);
    expect(result[0].name).toBe('Student_ae50b0a2');
    expect(JSON.stringify(result)).not.toContain('20f37658');
  });

  it('other students’ submitted work is redacted', () => {
    const submissions = [
      {
        id: 1,
        user_id: 54321,
        submitted_at: '2026-03-01T12:00:00Z',
        body: 'Essay by Jane Smith, jane.smith@university.edu',
        url: 'https://example.com/jsmith7',
        attachments: [{ id: 5, display_name: 'Smith, Jane - essay.pdf' }],
        submission_comments: [
          { id: 2, author_id: 777, author_name: 'Jane Smith', comment: 'SSN 123-45-6789, phone 217-555-0199' },
        ],
      },
    ];
    const result = throughClient(submissions, '/courses/1/assignments/2/submissions');
    expectNoRosterPii(result);
    expect(result[0].body).toBe('[CONTENT_REDACTED_FOR_Student_20f37658]');
    expect(result[0].url).toBe('[CONTENT_REDACTED_FOR_Student_20f37658]');
    expect(result[0].attachments).toBe('[CONTENT_REDACTED]');
    expect(result[0].submission_comments[0].comment).toBe('SSN [SSN_REDACTED], phone [PHONE_REDACTED]');
    expect(result[0].user_id).toBe(54321);
  });

  it('discussion posts lose author identity and inline contact details', () => {
    const view = {
      participants: [{ id: 54321, display_name: 'Jane Smith', avatar_image_url: 'https://canvas/a.png' }],
      view: [
        {
          id: 1,
          user_id: 54321,
          user_name: 'Jane Smith',
          message: 'Reach me: jane.smith@university.edu / ２１７-５５５-０１９９ / 217-555-0199',
        },
      ],
    };
    const result = throughClient(view, '/courses/1/discussion_topics/3/view');
    expectNoRosterPii(result);
    expect(result.view[0].message).toBe('Reach me: [EMAIL_REDACTED] / [PHONE_REDACTED] / [PHONE_REDACTED]');
    expect(result.participants[0].display_name).toBe(result.view[0].user_name);
  });
});

describe('a student’s own record is not hidden from them', () => {
  it.each(['/users/self', '/users/self/profile'])('%s is returned as Canvas sent it', (path) => {
    const profile = roster()[0];
    expect(throughClient(profile, path)).toBe(profile);
  });

  it('the caller’s own submission keeps its content', () => {
    const submission = { id: 1, user_id: 54321, submitted_at: '2026-03-01T12:00:00Z', body: 'My own essay text' };
    expect(throughClient(submission, '/courses/1/assignments/2/submissions/self')).toBe(submission);
  });
});

describe('partial tiers', () => {
  it('the inbox keeps correspondents’ names but not their contact details', () => {
    const conversations = [
      {
        id: 1,
        last_message: 'Email jane.smith@university.edu or call 217-555-0199',
        participants: [{ id: 54321, name: 'Jane Smith', pronouns: 'she/her', avatar_url: 'https://canvas/a.png' }],
      },
    ];
    const result = throughClient(conversations, '/conversations');
    expect(result[0].last_message).toBe('Email [EMAIL_REDACTED] or call [PHONE_REDACTED]');
    expect(result[0].participants[0]).toEqual({ id: 54321, name: 'Jane Smith', pronouns: null, avatar_url: null });
  });

  it('a page keeps its instructor-authored body but not the editor’s identity', () => {
    const page = {
      title: 'Syllabus',
      body: 'Office hours: prof@university.edu, 217-555-0100',
      last_edited_by: { id: 54321, display_name: 'Jane Smith', avatar_image_url: 'https://canvas/a.png' },
    };
    for (const path of ['/courses/1/pages/syllabus', '/courses/1/front_page']) {
      const result = throughClient(page, path);
      expect(result.body).toBe(page.body);
      expect(result.last_edited_by).toEqual({ id: 54321, display_name: 'Student_20f37658', avatar_image_url: null });
    }
  });
});
