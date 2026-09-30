"""Story preparation must not leak unrelated roster identities into its actor list."""
import json
import unittest
from core.broadcast.providers.story_model import story_prompt

class StoryIdentityTest(unittest.TestCase):
    def test_only_players_in_accepted_evidence_enter_actor_context(self):
        players = [{'id': 'p1', 'name': 'Visible Player', 'teamId': 'DAL', 'jersey': '2'},
                   {'id': 'p2', 'name': 'Unreviewed Player', 'teamId': 'HOU', 'jersey': '4'},
                   {'id': 'p3', 'name': 'Bench Player', 'teamId': 'DAL', 'jersey': '7'}]
        def observation(oid, person, status):
            return {'id':oid,'type':'movement','start':1,'end':2,'anchorTime':2,'segmentId':'s1',
                    'description':'Player moves toward the basket.','playerIds':[person], 'frameIds':[],
                    'review':{'status':status}}
        project={'media':{'duration':10},'context':{'roster':players},'bindings':[],'metrics':None,
                 'observations':[observation('o1','p1','accepted'),observation('o2','p2','unreviewed')]}
        prompt=story_prompt(project,'fan',{})
        evidence=json.loads(prompt.split('输入JSON：',1)[1])
        self.assertEqual([actor['id'] for actor in evidence['actors']],['p1'])
        self.assertEqual([o['id'] for o in evidence['observations']],['o1'])

if __name__=='__main__':unittest.main()
