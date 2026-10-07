import { readFile } from 'node:fs/promises';
const sample = JSON.parse(await readFile(new URL('../../examples/product.json', import.meta.url), 'utf8'));
export function normalized(job) {
  const product = structuredClone(sample);
  product.sources = [job.sourceDescriptor];
  product.evidence = product.evidence.map(entry => ({ ...entry, sourceId: job.sourceDescriptor.id }));
  product.departures = []; product.cancellation = null;
  return product;
}
export function registration(image) {
  return {
    basic: { options: { cityLabel: '제주(CJU)', managerLabel: '가상담당자 (테스트팀)', priority: 7, cutoffDays: 3 } },
    display: { fields: { short_description: 'Fixture overview' }, images: [{ sourceImageId: image.id }], imageQuery: image.name },
    content: { detail: { include: [{ name: 'Hotel', description: 'One night' }], exclude: [], information: ['Fixture note'], mainPoints: ['Fixture point'], shoppingCount: '0' }, elements: [{ type: '3', text: 'Fixture heading' }, { type: '1', text: 'Fixture body' }] },
    shell: { title: 'Fixture schedule' }
  };
}
