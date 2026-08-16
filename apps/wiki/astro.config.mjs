import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  outDir: '../../dist/apps/wiki',
  integrations: [
    starlight({
      title: 'skill-sync',
      description: 'Manage a Git-backed library of AI skills across Codex and Claude projects.',
      pagefind: true,
      lastUpdated: true,
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/moonryc/skill-sync',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/moonryc/skill-sync/edit/main/apps/wiki/',
      },
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: '#111827' },
        },
      ],
      sidebar: [
        { label: 'Overview', link: '/' },
        {
          label: 'Start here',
          items: ['getting-started/installation', 'getting-started/quick-start'],
        },
        {
          label: 'Concepts',
          items: ['concepts/library-model', 'concepts/project-state'],
        },
        {
          label: 'Guides',
          items: ['guides/library-workflows', 'guides/project-workflows'],
        },
        {
          label: 'Command reference',
          items: [
            'reference',
            'reference/library-commands',
            'reference/project-commands',
            'reference/inspection',
            'reference/recovery-commands',
            'reference/configuration',
          ],
        },
        {
          label: 'Operations',
          items: [
            'operations/conflicts-and-recovery',
            'operations/security',
            'operations/automation',
            'troubleshooting',
          ],
        },
        {
          label: 'Contributing',
          items: ['contributing/architecture', 'contributing/development'],
        },
      ],
    }),
    react(),
  ],
});
