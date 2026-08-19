import { NextResponse } from 'next/server';
import { getVerifiedClaims } from '@/lib/supabase/server';
import { exportExcel, exportSdmxCsv, ExportError } from '@/export/service';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string; format: string }> },
) {
  const claims = await getVerifiedClaims();
  if (!claims) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  const { runId, format } = await params;

  try {
    if (format === 'sdmx-csv') {
      const { filename, body } = await exportSdmxCsv(claims, runId);
      return new NextResponse(body, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
        },
      });
    }
    if (format === 'xlsx') {
      const { filename, body } = await exportExcel(claims, runId);
      return new NextResponse(new Uint8Array(body), {
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': `attachment; filename="${filename}"`,
        },
      });
    }
    return NextResponse.json(
      { error: `Unknown export format "${format}". Use sdmx-csv or xlsx.` },
      { status: 400 },
    );
  } catch (e) {
    if (e instanceof ExportError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    return NextResponse.json({ error: 'The export failed.' }, { status: 500 });
  }
}
