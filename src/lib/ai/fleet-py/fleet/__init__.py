"""Agent tools for workspace scripts.

A script in the agent workspace calls the app's own tools as the person whose run started it, with that run's access rules, through the
app on this machine (loopback only). Saved keys never reach the script: the app uses them and returns the answer.

    import fleet
    fleet.call('search_knowledge', query='onboarding')
    fleet.slack.post('C0123', 'Hello')
    fleet.slack.history('C0123', since='2026-10-01')     # every message, oldest first (pages for you)
"""
import json
import os
import urllib.error
import urllib.request

__all__ = ['call', 'call_json', 'FleetError', 'slack']


class FleetError(Exception):
    """A Fleet tool refused or failed; the message is its reason."""


def _key():
    d = os.environ.get('CREDENTIALS_DIRECTORY')
    if not d or not os.path.exists(os.path.join(d, 'fleet_key')):
        raise FleetError('No Fleet key: scripts reach Fleet tools only when started by workspace_run.')
    return open(os.path.join(d, 'fleet_key')).read().strip()


_id = 0


def call(tool, **args):
    """Calls one Fleet tool; returns its text answer. Raises FleetError when the tool refuses or fails."""
    global _id
    _id += 1
    req = urllib.request.Request(os.environ.get('FLEET_MCP_URL', 'http://127.0.0.1:3000/api/ai/mcp'),
                                 data=json.dumps({'jsonrpc': '2.0', 'id': _id, 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}}).encode(),
                                 headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {_key()}'})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            out = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise FleetError(f'Fleet answered {e.code}: the run may have ended (keys last as long as the command).') from None
    if 'error' in out:
        raise FleetError(out['error'].get('message', 'Fleet error'))
    res = out.get('result', {})
    text = ''.join(c.get('text', '') for c in res.get('content', []))
    if res.get('isError'):
        raise FleetError(text)
    return text


def call_json(tool, **args):
    """call(), parsed as JSON when it is JSON (else the text)."""
    t = call(tool, **args)
    try:
        return json.loads(t)
    except ValueError:
        return t


class _Slack:
    def post(self, channel, text, thread_ts=None, markdown=False):
        """Posts as the agency's bot, shown as sent by the person (via the AI); markdown=True: standard Markdown, Slack's markdown block."""
        args = {'channel': channel, 'text': text, **({'markdown': True} if markdown else {})}
        if thread_ts:
            args['thread_ts'] = thread_ts
        return call('propose_slack_post', **args)

    def people(self, query):
        return call('slack_people', query=query)

    def history(self, channel, since, until=None, threads=False):
        """Every message after `since` (Slack ts or YYYY-MM-DD) up to `until`, oldest first, as dicts {ts, user, text, ...}."""
        out, cur = [], str(since)
        while True:
            args = {'channel': channel, 'since': cur, 'limit': 5000, 'threads': threads}
            if until:
                args['until'] = str(until)
            page = call_json('slack_history', **args)
            out.extend(page['messages'])
            if not page.get('next_oldest'):
                return out
            cur = page['next_oldest']


slack = _Slack()
